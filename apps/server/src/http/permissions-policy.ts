// The Permissions-Policy header (FR-A-040, plan 8.1 and Appendix A, PD-01).
//
// Verification finding (plan V-02, Appendix A): a local HTTP server answered with
// `Permissions-Policy: <feature>=()` for each of 88 candidate names and Chromium 141.0.7390.37's
// console was read for `Unrecognized feature`. The 45 names below are the ones it recognises and
// that are capabilities the app does not use. Not set on purpose: `cross-origin-isolated` (the
// pages are isolated), `deferred-fetch` and the `ch-ua*` client hints (delegation, not a
// capability). Names Chromium 141 does not recognise (`battery`, `bluetooth`, `web-share`,
// `notifications`, `push`, `wake-lock`, and the others listed in Appendix A) are NOT in the list: a
// name the browser does not know logs a console warning, and the e2e fixture turns every warning
// that mentions `Permissions-Policy` into a failure (FR-A-042), which is how a browser upgrade that
// drops a name gets noticed. Firefox and Safari ignore or warn on names they do not know; not
// verified there.
//
// `server/security-headers.test.ts` reads Appendix A of the plan and compares it with this list, so
// the finding and the constant cannot drift apart silently.

/** Every feature the app does not use, each disabled with an empty allow-list: `<name>=()`. */
export const DISABLED_FEATURES: readonly string[] = Object.freeze([
  'accelerometer',
  'attribution-reporting',
  'autoplay',
  'browsing-topics',
  'camera',
  'captured-surface-control',
  'clipboard-read',
  'compute-pressure',
  'digital-credentials-get',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'identity-credentials-get',
  'idle-detection',
  'interest-cohort',
  'join-ad-interest-group',
  'keyboard-map',
  'language-detector',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'on-device-speech-recognition',
  'otp-credentials',
  'payment',
  'picture-in-picture',
  'private-state-token-issuance',
  'private-state-token-redemption',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'run-ad-auction',
  'screen-wake-lock',
  'serial',
  'storage-access',
  'summarizer',
  'sync-xhr',
  'translator',
  'unload',
  'usb',
  'window-management',
  'xr-spatial-tracking',
]);

/** The one feature the app uses: the copy buttons write to the clipboard from the page itself. */
const ALLOWED_FEATURES: readonly string[] = Object.freeze(['clipboard-write=(self)']);

/** The header value: the disabled features first, then the one allowed feature. */
export const FEATURE_POLICY: string = [
  ...DISABLED_FEATURES.map((name) => `${name}=()`),
  ...ALLOWED_FEATURES,
].join(', ');
