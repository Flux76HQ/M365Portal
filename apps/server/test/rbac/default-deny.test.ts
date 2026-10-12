// T-B-240, FR-B-506, FR-B-413, plan 11.7: default no access. A principal without an active grant holds
// nothing, an actor never holds a permission by Entra role, only the resolvers build the three actors
// that hold anything, and the preview actor is nowhere in the source of the server.
//
// The sign-in half (a principal without a grant gets no session and the `no_role` page) is
// `server/auth/*`; this file proves what that decision reads: an empty list of grants.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { authorize } from '../../src/policy/index.js';
import { createPolicyHarness } from '../helpers/policy-harness.js';
import { assign, guid } from '../helpers/rbac-db.js';

const TWENTY_MINUTES = 20 * 60_000;

describe('a principal without an active grant holds nothing (FR-B-506)', () => {
  it('has no grants without an assignment, and every permission is refused', async () => {
    const harness = await createPolicyHarness();
    expect(harness.grants.grantsFor({ oid: guid(1), groupsResolvedAt: null })).toEqual([]);
    const actor = harness.resolve(harness.request(harness.seedSession({ oid: guid(1) })));
    for (const permission of PERMISSIONS) {
      expect(authorize(actor, permission), permission).toEqual({
        allow: false,
        reason: 'permission_missing',
      });
    }
  });

  it('has no grants once the last assignment has expired, while the session is still valid', async () => {
    const harness = await createPolicyHarness();
    assign(harness.db, {
      principalId: guid(1),
      role: 'admin',
      expiresAt: new Date(harness.clock.nowMs() + TWENTY_MINUTES).toISOString(),
    });
    const session = harness.seedSession({ oid: guid(1) });
    expect(harness.resolve(harness.request(session)).permissions.size).toBe(13);
    harness.clock.advance(TWENTY_MINUTES);
    const actor = harness.resolve(harness.request(session));
    expect(actor.kind).toBe('user');
    expect(actor.permissions.size).toBe(0);
  });

  it('holds nothing by an Entra role: a Global Administrator without an assignment is refused', async () => {
    const harness = await createPolicyHarness();
    const request = new Request('http://localhost:9300/api/v1/me', {
      headers: {
        ...harness.seedSession({ oid: guid(1) }).headers,
        'x-wids': '62e90394-69f5-4237-9190-012177145e10',
        'x-roles': 'Global Administrator',
        authorization: 'Bearer eyJ0.eyJ3aWRzIjpbIjYyZTkwMzk0Il19.sig',
      },
    });
    const actor = harness.resolve(request);
    expect(actor.permissions.size).toBe(0);
    expect(authorize(actor, 'rbac:manage').allow).toBe(false);
  });

  it('never reads the claims of a token: the resolver has no code for groups or wids', () => {
    const resolvers = join(sourceRoot, 'policy');
    const text = sourcesBelow(resolvers)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/_claim_names|_claim_sources|hasgroups|\bwids\b/);
  });
});

const sourceRoot = fileURLToPath(new URL('../../src', import.meta.url));

function sourcesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesBelow(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

const ACTOR_LITERAL = /kind:\s*['"](user|setup|break_glass)['"]\s*[,}]/;

describe('only the resolvers build an actor (FR-B-506, plan 11.7)', () => {
  it('finds no kind literal of a user, setup or break_glass actor outside policy/resolvers', () => {
    const outside = sourcesBelow(sourceRoot)
      .filter((file) => !relative(sourceRoot, file).startsWith(join('policy', 'resolvers')))
      .filter((file) => ACTOR_LITERAL.test(readFileSync(file, 'utf8')))
      .map((file) => relative(sourceRoot, file));
    expect(outside).toEqual([]);
  });

  it('finds the three literals inside policy/resolvers (the scan reads the right place)', () => {
    const inside = sourcesBelow(join(sourceRoot, 'policy', 'resolvers'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const kind of ['user', 'setup', 'break_glass']) {
      expect(inside).toContain(`kind: '${kind}'`);
    }
  });

  it('negative fixture: the scan finds an actor built outside the resolvers', () => {
    const scan = (text: string): void => {
      if (ACTOR_LITERAL.test(text)) throw new Error('an actor is built here');
    };
    expectGuardFails(scan, "export const sneaky = { kind: 'break_glass', id: 'x' };", {
      reason: 'an actor is built here',
    });
    expectGuardFails(scan, 'const a = {\n  kind: "setup" }', { reason: 'an actor is built here' });
    expect(() => {
      scan("export const fine = { kind: 'anonymous', id: 'x' };");
    }).not.toThrow();
  });

  it('has no preview actor, resolver or Host rule in the source of the server', () => {
    const offenders = sourcesBelow(sourceRoot)
      .filter((file) =>
        /PREVIEW_ACTOR|resolvePreview|announcePreviewMode|PREVIEW_WARNING|withTransitionalPreview/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });
});
