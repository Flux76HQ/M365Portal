// The setup resolver (plan 9.2, FR-B-202, FR-B-205): a valid setup cookie is the `setup` actor, with the
// fixed grants of `fixed-grants.ts`, while the setup is not completed. The cookie names a session held
// in memory by the setup module (`SetupSessionReader`, T-B-125); nothing else makes this actor.
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { frozenSetOf, type Actor } from '../actor.js';
import { SETUP_GRANTS } from '../fixed-grants.js';
import type { SetupSessionReader } from '../ports.js';
import { hashSessionId } from '../session-hash.js';

const SETUP_PERMISSIONS = frozenSetOf(
  PERMISSIONS.filter((permission) => SETUP_GRANTS.some((grant) => grant.permission === permission)),
);

export function resolveSetupActor(
  reader: SetupSessionReader | undefined,
  cookie: string | undefined,
  binding: string,
): Actor | undefined {
  if (reader === undefined || cookie === undefined) return undefined;
  const idHash = hashSessionId(cookie);
  if (reader.find(idHash) === undefined) return undefined;
  return Object.freeze({
    kind: 'setup',
    id: 'setup',
    label: 'Setup',
    permissions: SETUP_PERMISSIONS,
    grants: SETUP_GRANTS,
    csrfBinding: binding,
    credential: 'valid',
    session: null,
    setupSession: Object.freeze({ idHash }),
    stepUpFresh: false,
  });
}
