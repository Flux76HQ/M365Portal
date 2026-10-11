// A bridge for the Phase A tests that still need the preview actor (T-B-009). `PREVIEW_MODE` and
// `PREVIEW_MODE_ALLOW_REMOTE` are gone from the configuration (FR-B-102): `loadConfig` ignores them,
// so a server started with them is the same as one started without. The Phase A preview resolver is
// still in `policy/` until T-B-240 deletes it, and the tests that exercise it (the branding routes,
// the CSRF and Origin guards, the audit of denials) build their application from a configuration
// that has the two deprecated optional fields set. This helper sets them from the env they pass, in
// test code only; nothing under `src/` reads the environment for them.
//
// T-B-245 migrates these tests to `signedInAs` and deletes this file with the resolver.
import type { AppConfig } from '../../src/config/index.js';

type Env = Readonly<Record<string, string | undefined>>;

/** `config` with the deprecated preview flags taken from `env`; `config` itself when neither is set. */
export function withLegacyPreview(config: AppConfig, env: Env): AppConfig {
  const previewMode = env.PREVIEW_MODE === 'true';
  const previewModeAllowRemote = env.PREVIEW_MODE_ALLOW_REMOTE === 'true';
  if (!previewMode && !previewModeAllowRemote) return config;
  return Object.freeze({ ...config, previewMode, previewModeAllowRemote });
}
