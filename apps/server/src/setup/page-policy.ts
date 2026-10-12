// What a page navigation gets while setup exists (T-B-126, FR-B-201, FR-B-207, SB-14, SB-26, XB20): the
// answer the SPA fallback asks for before it renders the shell.
//
//   /setup and /setup/*   the shell while the gate is open; HTTP 404 otherwise (the state is
//                         `completed`, or the loopback guard refuses). The shell renders Not-found.
//   any other page        while the state is not `completed` and the gate is open: 303 to `/setup`,
//                         unless the path is `/signin` or `/no-access`, or the request carries a
//                         valid user (or break-glass) session. A non-designated user who signs in
//                         during `awaiting_first_signin`, and a user without a role, must not bounce
//                         to the token form.
//   anything else         the shell.
import type { PagePolicy } from '../http/spa-fallback.js';
import type { ModuleDeps } from '../module.js';
import type { SetupGate } from './availability.js';

export const SETUP_PAGE_PATH = '/setup';

/** Pages that never redirect to the wizard (SB-14, SB-26). */
const EXEMPT_PAGES: readonly string[] = ['/signin', '/no-access'];

export function isSetupPage(path: string): boolean {
  return path === SETUP_PAGE_PATH || path.startsWith(`${SETUP_PAGE_PATH}/`);
}

export function createSetupPagePolicy(
  gate: SetupGate,
  deps: Pick<ModuleDeps, 'resolveActor'>,
): PagePolicy {
  return {
    decide(request, path) {
      const state = gate.state();
      if (isSetupPage(path)) return gate.isOpen(request) ? 'shell' : 'not_found';
      if (state === undefined || state === 'completed') return 'shell';
      if (!gate.guardOpen(request)) return 'shell';
      if (EXEMPT_PAGES.some((page) => path === page || path.startsWith(`${page}/`))) return 'shell';
      const actor = deps.resolveActor(request);
      if (actor.kind === 'user' || actor.kind === 'break_glass') return 'shell';
      return { redirect: SETUP_PAGE_PATH };
    },
  };
}
