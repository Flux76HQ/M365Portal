// THE SWITCH OF THE NO-PHASE-B GUARD (T-A-333, baseline section 7, SC-A-015).
//
// `CURRENT_PHASE` is the one constant that says which phase the repository is in. While it is 'A'
// (Phase A is built, not yet approved by the owner's line in docs/phase-reports/phase-A.md) the guard
// in `traceability.test.ts` fails when anything of Phase B exists in `apps/`, in a manifest or in the
// workspace catalogue: the wizard, OIDC sign-in, real sessions, RBAC data, secrets at rest, Graph and
// Exchange clients, MSW, OpenTelemetry. That is how "nothing for Phase B is started before the owner
// approves" (AGENTS.md section 1, spec section 3) is enforced by a script and not only by reading.
//
// WHEN PHASE B CODE LANDS, change this ONE line to 'B' in the same commit that adds the first Phase B
// file (the owner has authorised Phase B after Phase A; the commit that does it says so). Nothing else
// needs to change: the Phase A checks (every MUST has a control, every named path exists) keep running
// and only the ban on Phase B artefacts is lifted (the test says so in its title). Phase B's own plan
// adds the matching ban on Phase C artefacts (plan 002, section 14.7); that is a Phase B task and not
// done here.
export type Phase = 'A' | 'B';

export const CURRENT_PHASE: Phase = 'B';

/** Whether the ban on Phase B artefacts applies. */
export function phaseGuardIsActive(phase: Phase = CURRENT_PHASE): boolean {
  return phase === 'A';
}

/** Manifests must not declare these while the guard is active (task T-A-333). `*` ends a scope prefix. */
export const PHASE_B_DEPENDENCIES: readonly string[] = [
  '@azure/msal-node',
  '@microsoft/microsoft-graph-client',
  'jose',
  'libsodium-wrappers',
  'msw',
  '@opentelemetry/*',
];

/** Server source directories that only Phase B creates. */
export const PHASE_B_SERVER_DIRECTORIES: readonly string[] = ['auth', 'session', 'rbac', 'setup'];

/** String literals (route paths) that only Phase B registers, in the source code of apps (comments are ignored). */
export const PHASE_B_ROUTE_PATHS: readonly string[] = [
  '/setup',
  '/signin',
  '/api/v1/session',
  '/api/v1/setup',
  '/api/v1/auth',
];

/** Declarations that only Phase B introduces (a class, interface, type, function or variable of this name). */
export const PHASE_B_DECLARATIONS: readonly string[] = [
  'GraphClient',
  'ExchangeClient',
  'SetupWizard',
  'OidcClient',
];

/** Requirements whose only control is review, with the reason (the task's allow-list). */
export const REVIEW_ONLY: Readonly<Record<string, string>> = {
  'FR-A-188':
    'the phase gate: the owner records the approval in docs/phase-reports/phase-A.md; a person, not a script, approves (spec section 3 item 4, baseline section 17)',
  'FR-A-103':
    'the colour-only rule of WCAG 1.4.1 is only partly automatable; the manual checklist of docs/architecture.md (FR-A-185) covers the rest, stated in the row; the automated part (axe) is checked as any other',
};
