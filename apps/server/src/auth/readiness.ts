// Can anyone sign in right now? (T-B-182, FR-B-402, SB-22) One answer for the login route and the
// callback:
//
//   setup_required        the state is `unconfigured` or `in_progress` (for example after
//                         `setup-reopen`), or no tenant is pinned
//   secrets_unavailable   the application key or the certificate cannot be used (FR-B-108)
//   temporarily_unavailable  there is no database (degraded mode)
//
// Sign-in is allowed from `awaiting_first_signin` on. The sign-in client is taken from the clients
// registry, which says `SecretsUnavailableError` or `NotConnectedError` itself.
import type { SigninErrorCode } from '@m365portal/shared/auth/signin-errors';
import { SETUP_STATES, type SetupState } from '@m365portal/shared/setup/steps';
import type { DatabaseHandle } from '../db/index.js';
import { readTenantPin, type TenantPin } from '../integrations/tenant-pin.js';
import type { ModuleDeps } from '../module.js';
import { NotConnectedError, SecretsUnavailableError } from '../ports/errors.js';
import type { OidcClient } from '../ports/identity.js';

export type SignInReadiness =
  | { readonly ok: true; readonly oidc: OidcClient; readonly pin: TenantPin }
  | {
      readonly ok: false;
      readonly error: Extract<
        SigninErrorCode,
        'setup_required' | 'secrets_unavailable' | 'temporarily_unavailable'
      >;
    };

const SIGN_IN_STATES: ReadonlySet<SetupState> = new Set(['awaiting_first_signin', 'completed']);

/** The setup state, or `unconfigured` when the row is absent. */
export function setupStateOf(db: DatabaseHandle): SetupState {
  const row = db.sqlite.prepare('SELECT state FROM setup_state WHERE id = 1').get() as
    | { state: string }
    | undefined;
  return SETUP_STATES.find((state) => state === row?.state) ?? 'unconfigured';
}

export function signInReadiness(deps: ModuleDeps): SignInReadiness {
  const db = deps.database();
  if (db === undefined) return { ok: false, error: 'temporarily_unavailable' };
  if (!SIGN_IN_STATES.has(setupStateOf(db))) return { ok: false, error: 'setup_required' };
  const pin = readTenantPin(db);
  if (pin === undefined) return { ok: false, error: 'setup_required' };
  if (deps.secrets.state().status !== 'ok') return { ok: false, error: 'secrets_unavailable' };
  try {
    return { ok: true, oidc: deps.clients.oidc(), pin };
  } catch (failure) {
    if (failure instanceof SecretsUnavailableError) {
      return { ok: false, error: 'secrets_unavailable' };
    }
    if (failure instanceof NotConnectedError) return { ok: false, error: 'setup_required' };
    throw failure;
  }
}
