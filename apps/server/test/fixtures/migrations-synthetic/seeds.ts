// Rows for the synthetic fixtures of the upgrade harness (T-A-038): what a database at version 0 of
// `version-pair`, `drifting-pair` and `table-rebuild-pair` holds before the upgrade. Every table has
// rows, the child table has rows that depend on their parent, and the audit log holds a hash chain
// written the way an older version of the application would have written it.
import { appendReference } from '../../helpers/audit-reference.js';
import type { SqliteConnection } from '../../../src/db/open.js';

export function seedSyntheticVersion0(db: SqliteConnection): void {
  const owner = db.prepare('INSERT INTO owner (id, name) VALUES (?, ?)');
  owner.run(1, 'ada');
  owner.run(2, 'bob');

  const pet = db.prepare('INSERT INTO pet (id, owner_id, name) VALUES (?, ?, ?)');
  pet.run(1, 1, 'rex');
  pet.run(2, 1, 'tom');
  pet.run(3, 2, 'fido');

  appendReference(db, {
    ts: '2026-10-10T12:00:00.000Z',
    actorKind: 'system',
    actorId: 'system',
    action: 'owner.init',
    targetType: 'owner',
    targetId: '1',
    outcome: 'success',
  });
  appendReference(db, {
    ts: '2026-10-10T12:00:01.000Z',
    actorKind: 'anonymous',
    actorId: 'anonymous',
    action: 'owner.rename',
    targetType: 'owner',
    targetId: '2',
    outcome: 'denied',
    reasonCode: 'permission_denied',
    clientIp: '192.0.2.10',
    requestId: 'req-0000-0001',
    detail: '{"permission":"settings:branding"}',
  });
  // A detail with white space and non-ASCII text: the hash covers the stored text byte for byte.
  appendReference(db, {
    ts: '2026-10-10T12:00:02.500Z',
    actorKind: 'preview',
    actorId: 'preview',
    action: 'owner.rename',
    targetType: 'owner',
    targetId: '1',
    outcome: 'success',
    detail: '{"old": "Åda", "new": "Ada — 日本"}',
  });
}
