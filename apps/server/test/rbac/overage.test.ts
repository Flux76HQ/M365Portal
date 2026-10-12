// T-B-247, FR-B-507, EB-18: the token's group claims are ignored entirely. A user whose token says
// "member of 250 groups" (and carries `_claim_names` and `hasgroups`, the overage markers) holds the
// rights of the direct assignments and of `checkMemberGroups` only; nothing is fetched from the
// `_claim_sources` endpoint and the `groups` entries are not an input of anything.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging/logger.js';
import { createGrantsService } from '../../src/rbac/grants.js';
import { createMembershipService } from '../../src/rbac/membership.js';
import { FakeGraphClient } from '../fakes/fake-graph-client.js';
import { FakeDirectory, fakeGuid } from '../fakes/fake-tenant/graph/index.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { assign, createMigratedDatabase, TENANT } from '../helpers/rbac-db.js';
import { readServerSources, stripComments } from '../helpers/source-files.js';

describe('a token with group claims and the overage markers (EB-18)', () => {
  it('gets the rights of the direct assignment and of checkMemberGroups, whatever the token says', async () => {
    const clock = createFakeClock();
    const directory = new FakeDirectory({ clock: { now: () => clock.nowMs() } });
    const graph = new FakeGraphClient(directory);
    const user = directory.addUser({ userPrincipalName: 'alice@contoso-fake.example' });
    const db = await createMigratedDatabase();
    db.sqlite
      .prepare(
        `INSERT INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at)
         VALUES (?, ?, NULL, 'Alice', '2026-10-10T11:00:00.000Z', '2026-10-10T11:00:00.000Z', NULL)`,
      )
      .run(TENANT, user.id);

    // Two groups are bound to roles. The user is a member of the helpdesk group only.
    const helpdesk = directory.addGroup({ displayName: 'helpdesk' });
    const admins = directory.addGroup({ displayName: 'admins' });
    directory.addMember(helpdesk.id, user.id);
    assign(db, { principalType: 'group', principalId: helpdesk.id, role: 'helpdesk' });
    assign(db, { principalType: 'group', principalId: admins.id, role: 'admin' });
    assign(db, { principalId: user.id, role: 'reader' });

    // What the token says: 250 group ids (every bound group among them), and the overage markers.
    const claims = {
      oid: user.id,
      groups: [admins.id, helpdesk.id, ...Array.from({ length: 248 }, (_, i) => fakeGuid('g', i))],
      hasgroups: true,
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.example/getMemberObjects' } },
    };
    expect(claims.groups).toHaveLength(250);

    const membership = createMembershipService({
      database: () => db,
      graph: () => graph,
      now: () => clock.nowMs(),
      ttlMs: 300_000,
      log: createLogger({ level: 'debug', destination: createLogCapture() }),
    });
    // The service takes the object id and nothing else: there is no parameter that carries claims.
    const refreshed = await membership.refresh(claims.oid);
    expect(refreshed).toMatchObject({ ok: true, groupIds: [helpdesk.id] });

    const grants = createGrantsService({ database: () => db, now: () => clock.nowMs() });
    const held = grants.grantsFor({ oid: user.id, groupsResolvedAt: clock.iso() });
    const permissions = new Set(held.map((grant) => grant.permission));
    expect(permissions.has('groups:members:write')).toBe(true); // helpdesk, through the group
    expect(permissions.has('settings:branding')).toBe(false); // admin, claimed by the token only
    expect(permissions.has('rbac:manage')).toBe(false);

    // Graph was asked about the bound groups, and nothing else was fetched.
    expect(graph.calls.map((call) => call.method)).toEqual(['checkMemberGroups']);
    expect(graph.calls[0]?.args[1]).toEqual([admins.id, helpdesk.id].sort());
  });

  it('no source file of the server reads a group claim or the overage markers', () => {
    const files = readServerSources();
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /_claim_names|_claim_sources|hasgroups|claims\.groups|payload\.groups|\[['"]groups['"]\]/.test(
        stripComments(file.text),
      ),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});
