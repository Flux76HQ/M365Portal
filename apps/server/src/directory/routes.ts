// The seven routes of Phase C, P33 to P39 (T-C-024, FR-C-401): users first, then groups. All GET; none
// declares an audit action (a successful read is not audited, ODC-01); each handler asks the policy
// layer.
import type { RouteDefinition } from '../http/route.js';
import type { DirectoryContext } from './context.js';
import { groupsRoutes } from './groups-routes.js';
import { usersRoutes } from './users-routes.js';

export function directoryRoutes(directory: DirectoryContext): RouteDefinition[] {
  return [...usersRoutes(directory), ...groupsRoutes(directory)];
}
