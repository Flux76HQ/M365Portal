// TRANSITIONAL, deleted by T-B-240 together with the Phase A preview resolver (`policy/resolvers.ts`).
//
// Phase B removes `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` (FR-B-102). The configuration no
// longer reads them (`loadConfig` ignores both and the start says so once). But the Phase A preview
// actor resolver is still in `policy/` until the policy layer is rebuilt (T-B-240), and the Phase A
// tests that exercise branding end to end (T-B-245 migrates them to signed-in test actors) start a
// real server with `PREVIEW_MODE=true` to get an actor with `settings:branding`. So that the tree
// stays green in between, the start hands the two flags to that resolver, taken from the raw
// environment, and nothing else reads them. When the resolver goes, this file goes, and a server
// started with `PREVIEW_MODE=true` is the same as one started without it (proven by T-B-240).
import type { AppConfig } from './env.js';

type Env = Readonly<Record<string, string | undefined>>;

/** `config` with the deprecated preview flags taken from `env`; `config` itself when neither is `true`. */
export function withTransitionalPreview(config: AppConfig, env: Env): AppConfig {
  const previewMode = env.PREVIEW_MODE === 'true';
  const previewModeAllowRemote = env.PREVIEW_MODE_ALLOW_REMOTE === 'true';
  if (!previewMode && !previewModeAllowRemote) return config;
  return Object.freeze({ ...config, previewMode, previewModeAllowRemote });
}
