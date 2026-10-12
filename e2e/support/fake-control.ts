// The client of the fake tenant's control surface (`fake-tenant-server.ts`, CB17), for global-setup and
// the specs. One typed method per thing a spec turns; the operations themselves live in the server.
import { fakeOrigin, type InstanceName } from './ports.js';
import { GLOBAL_ADMINISTRATOR_TEMPLATE_ID, PRINCIPALS, type PrincipalName } from './principals.js';

export interface FakeCall {
  readonly sequence: number;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly mutating: boolean;
}

export interface Inventory {
  readonly applications: number;
  readonly servicePrincipals: number;
  readonly keyCredentials: number;
  readonly redirectUris: string[];
  readonly namedApplications: string[];
}

export interface SignInOptions {
  /** Claims to set or replace in the ID token (for example `{ amr: ['pwd'] }`). */
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly omitClaims?: readonly string[];
  readonly signer?: string;
  readonly authorizeError?: { error: string; description?: string; aadsts?: number };
  readonly nonce?: string | null;
}

/** The panel's application as Microsoft Entra holds it. */
export interface PanelApplication {
  readonly appId: string;
  readonly objectId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly tags: string[];
  readonly redirectUris: string[];
  readonly implicitGrant: { enableIdTokenIssuance: boolean; enableAccessTokenIssuance: boolean };
  readonly optionalClaimNames: string[];
  readonly graphRoles: string[];
  readonly exchangeRoles: string[];
  readonly entraRoleTemplateIds: string[];
  readonly keyCredentials: number;
  readonly thumbprintsSha1: string[];
  readonly passwordCredentials: number;
  readonly owners: number;
}

export interface ManualApplicationSpec {
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly redirectUris: readonly string[];
  readonly optionalClaimNames: readonly string[];
  readonly graphRoles: readonly string[];
  readonly exchangeRoles: readonly string[];
  readonly entraRoleTemplateId?: string;
  /** The certificate the person downloaded, DER as base64. */
  readonly certificateBase64: string;
}

export class FakeControl {
  readonly #tenant: InstanceName;

  constructor(tenant: InstanceName) {
    this.#tenant = tenant;
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${fakeOrigin()}/control/${this.#tenant}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
    });
    const body = (await response.json()) as { result?: T; error?: string };
    if (response.status !== 200) {
      throw new Error(
        `fake tenant ${this.#tenant}: ${op} failed: ${body.error ?? String(response.status)}`,
      );
    }
    return body.result as T;
  }

  /** Back to the initial tenant (the people of `principals.ts`). */
  reset(): Promise<void> {
    return this.call('reset');
  }

  /** The next /authorize signs this principal in (one shot). */
  nextSignIn(principal: PrincipalName, options: SignInOptions = {}): Promise<void> {
    const person = PRINCIPALS[principal];
    const claims: Record<string, unknown> = {
      ...(person.widsGlobalAdministrator === true
        ? { wids: [GLOBAL_ADMINISTRATOR_TEMPLATE_ID] }
        : {}),
      ...options.claims,
    };
    return this.call('nextSignIn', {
      user: person.oid,
      ...(Object.keys(claims).length > 0 ? { claims } : {}),
      ...(options.omitClaims === undefined ? {} : { omitClaims: options.omitClaims }),
      ...(options.signer === undefined ? {} : { signer: options.signer }),
      ...(options.authorizeError === undefined ? {} : { authorizeError: options.authorizeError }),
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
  }

  /** The person at the device-code page signs in and consents: every waiting flow completes. */
  approveDevice(principal: PrincipalName = 'owner'): Promise<void> {
    return this.call('device.approve', { user: PRINCIPALS[principal].oid });
  }

  devicePending(): Promise<number> {
    return this.call('device.pending');
  }

  /** Waits until the panel has asked for a device code, then approves it. */
  async approveWhenPending(principal: PrincipalName = 'owner', timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.devicePending()) > 0) {
        await this.approveDevice(principal);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('the panel never asked for a device code');
  }

  panelApplication(): Promise<PanelApplication> {
    return this.call('panelApplication');
  }

  /** The panel's application, or `null` while the fake holds none with an install tag. */
  async panelApplicationOrNull(): Promise<PanelApplication | null> {
    try {
      return await this.panelApplication();
    } catch {
      return null;
    }
  }

  tenantId(): Promise<string> {
    return this.call('tenantId');
  }

  seedManualApplication(spec: ManualApplicationSpec): Promise<{ appId: string; tenantId: string }> {
    return this.call('seedManualApplication', { ...spec });
  }

  /** The first `calls` Exchange calls answer 403, as before a role has propagated. */
  exchangePropagation(calls: number): Promise<void> {
    return this.call('exchange.propagation', { calls });
  }

  /** A tenant without Exchange Online (no Exchange service principal). */
  removeExchangeServicePrincipal(): Promise<void> {
    return this.call('removeExchangeServicePrincipal');
  }

  /** Conditional Access blocks the device sign-in. */
  blockDevice(): Promise<void> {
    return this.call('device.block');
  }

  /** Every device flow that is waiting expires (the code of a flow nobody finished). */
  expireDevice(): Promise<void> {
    return this.call('device.expire');
  }

  declineDevice(): Promise<void> {
    return this.call('device.decline');
  }

  /** New objects are "not found" for this many calls (replication). */
  replicationDelay(calls: number): Promise<void> {
    return this.call('graph.replicationDelay', { calls });
  }

  /** The next `times` Graph calls whose `METHOD /path` matches (a regular expression source) answer `status`. */
  failGraph(times: number, status: 500 | 502 | 503 | 504, match?: string): Promise<void> {
    return this.call('graph.failWith', {
      times,
      status,
      ...(match === undefined ? {} : { match }),
    });
  }

  addForeignApplication(displayName: string): Promise<{ objectId: string; appId: string }> {
    return this.call('addForeignApplication', { displayName });
  }

  driftRemoveGraphGrant(role: string): Promise<{ removed: number }> {
    return this.call('drift.removeGraphGrant', { role });
  }

  driftSetRedirectUris(uris: readonly string[]): Promise<void> {
    return this.call('drift.setRedirectUris', { uris });
  }

  failToken(fault: Record<string, unknown>): Promise<void> {
    return this.call('entra.failToken', fault);
  }

  calls(): Promise<FakeCall[]> {
    return this.call('calls');
  }

  mutatingCalls(): Promise<FakeCall[]> {
    return this.call('calls.mutating');
  }

  clearCalls(): Promise<void> {
    return this.call('calls.clear');
  }

  inventory(): Promise<Inventory> {
    return this.call('inventory');
  }

  logouts(): Promise<{ postLogoutRedirectUri: string | null; redirected: boolean }[]> {
    return this.call('entra.logouts');
  }

  authorizeRequests(): Promise<{ prompt: string | null; redirectUri: string | null }[]> {
    return this.call('entra.authorizeRequests');
  }
}

export function fakeControl(tenant: InstanceName): FakeControl {
  return new FakeControl(tenant);
}
