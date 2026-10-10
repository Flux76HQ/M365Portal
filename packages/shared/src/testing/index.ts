// `@m365portal/shared/testing`: helpers for test code only. Production code never imports this
// subpath, so none of it reaches the server bundle or the browser.
export {
  expectGuardFails,
  GuardDidNotFailError,
  type ExpectGuardFailsOptions,
  type GuardOutcome,
} from './expect-guard-fails.js';
