// A bridge for the Phase A tests that build their application from a configuration they load
// themselves (T-B-009). `loadConfig` ignores `PREVIEW_MODE*` (FR-B-102); the Phase A preview
// resolver is still in `policy/` until T-B-240, and these tests need its actor. The one
// implementation is `src/config/legacy-preview.ts` (also used by the start); this alias exists so
// the tests name what they do. T-B-245 migrates the tests to `signedInAs` and deletes both.
export { withTransitionalPreview as withLegacyPreview } from '../../src/config/legacy-preview.js';
