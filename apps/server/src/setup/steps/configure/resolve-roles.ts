// Role resolution (T-B-132, FR-B-302, EB-06; plan 9.5): the ids of the application roles are looked up
// at run time, never taken from a constant. For Microsoft Graph and for "Office 365 Exchange Online":
// `GET /servicePrincipals?$filter=appId eq '<resource appId>'&$select=id,displayName,appId,appRoles`,
// matching the role `value`, `allowedMemberTypes` containing `Application`, and `isEnabled`.
//
//   - a Graph role that is missing, disabled, or only for `User` stops with `app_role_missing`;
//   - the Exchange service principal missing is not an error: the tenant has no Exchange (EB-08) and
//     nothing first-party is created (research section 11);
//   - `Exchange.ManageAsApp` is required when the service principal exists; `Exchange.ManageAsAppV2` is
//     requested only when the service principal exposes it (Admin API Preview).
//
// The ids in `docs/permissions.md` are fixtures: a difference between the lookup and a fixture is a
// warning in the log (`setup.log.role_fixture_mismatch`), never an error and never a reason to use the
// fixture.
import {
  EXCHANGE_APP_ROLES,
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_APP_ROLES,
  GRAPH_RESOURCE_APP_ID,
} from '@m365portal/shared/setup/graph-roles';
import type { AppRoleInfo, ServicePrincipalInfo, TenantProvisioner } from '../../../ports/provisioner.js';
import { SetupFailure } from '../../context.js';

/**
 * The role ids documented in `docs/permissions.md`, by role name. Empty until that document lists them
 * (T-B-420); the comparison only ever logs. Never used as an id.
 */
export const ROLE_ID_FIXTURES: Readonly<Record<string, string>> = Object.freeze({});

export interface ResolvedRoles {
  readonly graphSpId: string;
  /** Absent when the tenant has no Exchange service principal. */
  readonly exchangeSpId: string | undefined;
  /** By role name: the four Graph roles and `Exchange.ManageAsApp` (+ `Exchange.ManageAsAppV2` when exposed). */
  readonly roleIds: Readonly<Record<string, string>>;
  /** Every application role the two resources offer, id to value: how a held assignment gets its name. */
  readonly roleNames: Readonly<Record<string, string>>;
}

export interface ResolveOptions {
  readonly fixtures?: Readonly<Record<string, string>>;
  readonly onFixtureMismatch?: (role: string) => void;
}

function usable(role: AppRoleInfo, name: string): boolean {
  return (
    role.value === name &&
    role.isEnabled === true &&
    role.allowedMemberTypes !== null &&
    role.allowedMemberTypes.includes('Application')
  );
}

function roleId(resource: ServicePrincipalInfo, name: string): string | undefined {
  return resource.appRoles?.find((role) => usable(role, name))?.id;
}

export async function resolveAppRoles(
  provisioner: TenantProvisioner,
  options: ResolveOptions = {},
): Promise<ResolvedRoles> {
  const graph = await provisioner.findServicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
  if (graph === null) throw new SetupFailure('app_role_missing', { name: 'Microsoft Graph' });
  const roleIds: Record<string, string> = {};
  const roleNames: Record<string, string> = {};
  const nameAll = (resource: ServicePrincipalInfo): void => {
    for (const role of resource.appRoles ?? []) if (role.value !== null) roleNames[role.id] = role.value;
  };
  nameAll(graph);
  const compare = (name: string, id: string): void => {
    const fixture = options.fixtures?.[name];
    if (fixture !== undefined && fixture !== id) options.onFixtureMismatch?.(name);
  };

  for (const name of GRAPH_APP_ROLES) {
    const id = roleId(graph, name);
    if (id === undefined) throw new SetupFailure('app_role_missing', { name });
    roleIds[name] = id;
    compare(name, id);
  }

  const exchange = await provisioner.findServicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
  if (exchange === null) return { graphSpId: graph.id, exchangeSpId: undefined, roleIds, roleNames };
  nameAll(exchange);

  const required = roleId(exchange, EXCHANGE_APP_ROLES.required);
  if (required === undefined) {
    throw new SetupFailure('app_role_missing', { name: EXCHANGE_APP_ROLES.required });
  }
  roleIds[EXCHANGE_APP_ROLES.required] = required;
  compare(EXCHANGE_APP_ROLES.required, required);
  const v2 = roleId(exchange, EXCHANGE_APP_ROLES.whenExposed);
  if (v2 !== undefined) {
    roleIds[EXCHANGE_APP_ROLES.whenExposed] = v2;
    compare(EXCHANGE_APP_ROLES.whenExposed, v2);
  }
  return { graphSpId: graph.id, exchangeSpId: exchange.id, roleIds, roleNames };
}
