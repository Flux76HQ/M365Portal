import type { FakeTenantClock } from '../types.js';
import { FakeDirectory } from './directory.js';
import { TokenLedger, type FakeWorld, type TokenAudience } from './tokens.js';

/** The client id of "Microsoft Graph Command Line Tools", the bootstrap client (FR-B-214). */
const BOOTSTRAP_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';

export interface CreateFakeWorldOptions {
  readonly clock: FakeTenantClock;
  readonly tenantId?: string;
}

export function createFakeWorld(options: CreateFakeWorldOptions): FakeWorld {
  const directory = new FakeDirectory({
    clock: options.clock,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
  });
  const tokens = new TokenLedger(options.clock, directory.tenantId);
  return {
    directory,
    tokens,
    issueAppToken(appId, audience: TokenAudience, issueOptions) {
      const grants = directory.snapshotGrants(appId);
      return tokens.issue({
        audience,
        kind: 'app',
        appId,
        roles: audience === 'graph' ? grants.graphRoles : grants.exchangeRoles,
        entraRoleTemplateIds: grants.entraRoleTemplateIds,
        ...(issueOptions?.lifetimeSeconds === undefined
          ? {}
          : { lifetimeSeconds: issueOptions.lifetimeSeconds }),
      });
    },
    issueDelegatedToken(spec) {
      return tokens.issue({
        audience: spec.audience ?? 'graph',
        kind: 'delegated',
        appId: spec.appId ?? BOOTSTRAP_CLIENT_ID,
        scopes: spec.scopes,
        userId: spec.userId,
        entraRoleTemplateIds: spec.entraRoleTemplateIds ?? [],
        ...(spec.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: spec.lifetimeSeconds }),
      });
    },
    reset() {
      directory.reset();
      tokens.reset();
    },
  };
}
