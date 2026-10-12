// T-B-131: the wizard's result codes are a projection of the shared AADSTS table (FR-B-217, TB-05, EB-04,
// EB-05). One case per documented code, an unknown code, and hostile description text.
import { AADSTS_NUMBER_REASONS } from '@m365portal/shared/auth/aadsts-map';
import { isResultCode, resultRemedyKey } from '@m365portal/shared/setup/result-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceCodeError, GraphForbiddenError } from '../../src/ports/errors.js';
import { connectFailureOf, offersManualMode } from '../../src/setup/aadsts.js';
import { HOSTILE_DESCRIPTION } from '../fakes/fake-tenant/entra/index.js';
import { SETUP_ACTOR, engineHarness, scripted } from './support/engine-harness.js';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the projection', () => {
  it.each([
    [{ kind: 'expired' }, 'device_code_expired'],
    [{ kind: 'declined' }, 'device_code_declined'],
    [{ kind: 'cancelled' }, 'device_code_cancelled'],
    [{ kind: 'blocked', aadsts: 53003 }, 'device_code_blocked'],
    [{ kind: 'bad_code' }, 'bootstrap_failed'],
    [{ kind: 'failed', aadsts: 65001 }, 'consent_required'],
    [{ kind: 'failed', aadsts: 90094 }, 'admin_approval_required'],
    [{ kind: 'failed', aadsts: 90093 }, 'admin_approval_required'],
    [{ kind: 'failed', aadsts: 50105 }, 'assignment_required'],
    [{ kind: 'failed', aadsts: 53003 }, 'device_code_blocked'],
  ] as const)('%j is %s', (input, code) => {
    const result = connectFailureOf(new DeviceCodeError(input));
    expect(result.code).toBe(code);
    expect(isResultCode(result.code)).toBe(true);
  });

  it('every documented number of the shared table with a wizard meaning has a code, the others fall to bootstrap_failed with the number', () => {
    for (const number of Object.keys(AADSTS_NUMBER_REASONS).map(Number)) {
      const result = connectFailureOf(new DeviceCodeError({ kind: 'failed', aadsts: number }));
      expect(isResultCode(result.code)).toBe(true);
      expect(result.detail.aadsts).toBe(number);
    }
    for (const number of [530036, 700027, 12345, 9999999]) {
      const result = connectFailureOf(new DeviceCodeError({ kind: 'failed', aadsts: number }));
      expect(result).toMatchObject({ code: 'bootstrap_failed', detail: { aadsts: number } });
    }
    expect(connectFailureOf(new DeviceCodeError({ kind: 'failed' }))).toMatchObject({
      code: 'bootstrap_failed',
      detail: {},
    });
  });

  it('a block offers the manual mode and names its own remedy; a custom BOOTSTRAP_CLIENT_ID is never the cure (EB-04)', () => {
    const blocked = connectFailureOf(new DeviceCodeError({ kind: 'blocked', aadsts: 53003 }));
    expect(offersManualMode(blocked.code)).toBe(true);
    expect(offersManualMode('consent_required')).toBe(true);
    expect(offersManualMode('admin_approval_required')).toBe(true);
    expect(offersManualMode('device_code_expired')).toBe(false);
    expect(offersManualMode(null)).toBe(false);
    expect(resultRemedyKey(blocked.code)).toBe('setup.remedy.device_code_blocked');
  });
});

describe('through the fake tenant', () => {
  it.each([
    [65001, 'consent_required'],
    [90094, 'admin_approval_required'],
    [50105, 'assignment_required'],
    [53003, 'device_code_blocked'],
    [70011, 'bootstrap_failed'],
  ] as const)(
    'AADSTS%d ends the connect step with %s and the hostile text of the answer never appears',
    async (aadsts, code) => {
      const scene = await tenantScene();
      scene.world.entra.control.failToken({
        grant: 'device_code',
        times: 1,
        answer: { status: 400, error: 'invalid_grant', description: HOSTILE_DESCRIPTION, aadsts },
      });
      scene.startRun(['connect']);
      await scene.drive({ approve: true, maxSeconds: 30 });
      await scene.engine.idle();
      expect(
        scene.rows(
          "SELECT status, error_code, detail FROM setup_step WHERE sub_action = 'device_code'",
        ),
      ).toEqual([{ status: 'failed', error_code: code, detail: JSON.stringify({ aadsts }) }]);
      const everything = [
        JSON.stringify(scene.engine.snapshot(0)),
        scene.logs.text(),
        JSON.stringify(scene.rows('SELECT * FROM audit_log')),
        JSON.stringify(scene.rows('SELECT * FROM setup_log')),
      ].join('\n');
      expect(everything).not.toContain('<script>');
      expect(everything).not.toContain('xxxxxxxx');
    },
  );
});

describe('a delegated 403 outside the propagation window (EB-05)', () => {
  it('means the bootstrap account lacks a role: bootstrap_role_insufficient', async () => {
    const h = await engineHarness({
      registry: scripted({
        'configure/graph_permissions': () => {
          throw new GraphForbiddenError({ graphCode: 'Authorization_RequestDenied' });
        },
      }),
    });
    h.services.bootstrap.begin({ cancel: vi.fn(), discard: vi.fn() } as never);
    h.services.bootstrap.signedIn(
      { tid: 't', oid: 'o', upnLabel: null, nameLabel: null },
      {} as never,
    );
    h.db.sqlite.prepare("UPDATE setup_step SET status = 'succeeded' WHERE step = 'connect'").run();
    h.engine.start({ steps: ['configure'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await h.engine.idle();
    const row = h.db.sqlite
      .prepare(
        "SELECT status, error_code, detail FROM setup_step WHERE sub_action = 'graph_permissions'",
      )
      .get() as { status: string; error_code: string; detail: string };
    expect(row).toMatchObject({ status: 'failed', error_code: 'bootstrap_role_insufficient' });
    expect(JSON.parse(row.detail)).toEqual({ graphErrorCode: 'Authorization_RequestDenied' });
  });
});
