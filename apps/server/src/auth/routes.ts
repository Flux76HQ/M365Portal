// The routes of the auth module (T-B-196, P01 to P06): the three browser endpoints at the root and the
// three JSON actions under `/api/v1/auth/`. Each lives in the file of the task that owns it; this one
// only lists them, in the order of the contract.
import type { RouteDefinition } from '../http/route.js';
import type { AuthContext } from './context.js';
import { breakGlassRoute, type BreakGlassAttempts } from './break-glass.js';
import { callbackRoute } from './callback.js';
import { loggedOutRoute, loginRoute } from './login.js';
import { logoutAllRoute, logoutRoute } from './logout.js';

export function authRoutes(ctx: AuthContext, breakGlass: BreakGlassAttempts | undefined): RouteDefinition[] {
  return [
    loginRoute(ctx),
    callbackRoute(ctx),
    loggedOutRoute(),
    logoutRoute(ctx),
    logoutAllRoute(ctx),
    breakGlassRoute(ctx, breakGlass),
  ];
}
