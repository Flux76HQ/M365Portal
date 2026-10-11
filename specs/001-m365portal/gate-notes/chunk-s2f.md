# Chunk note s2f (T-A-088 to T-A-091): open points, assumptions, risks

Written by the `s2f` worker for S8's consolidation (`T-A-278`) and for the worker of `T-A-092` (the module). No gate task (G2 is `T-A-094`). `modules.ts` and `T-A-092..094` were not touched.

## 1. Tasks and evidence

| Task | Files | Evidence |
|---|---|---|
| T-A-088 export and import | `src/branding/export-import.ts`, `src/branding/routes/export-import.ts`, `test/branding/export-import.test.ts` (64) | R10/R11 in the table (R11 rate class `upload`, body class `import`), documented in OpenAPI; every case of H-42 over a real route pipeline (duplicate, `__proto__`, `constructor`, unknown keys, bad base64, depth 10,000, 9,437,185 bytes gives 413, unknown version); a scanner unit suite; dry run stores nothing; tampered image fails the whole import with no staged file; export then import gives the same logo hashes and icons; cross-site export gives 403 with no audit row and no export built |
| T-A-089 serve assets | `src/branding/routes/serve-assets.ts`, `test/branding/serve-assets.test.ts` (28) | R12; 17 hostile names (H-43) are 404 `not_found`; headers; 304; unreferenced assets 404 for the anonymous actor and `private` for `settings:branding`; a deleted file is 404, the start check logs `branding_asset_missing`, readiness stays ready |
| T-A-090 manifest and icons | `src/branding/manifest.ts`, `src/branding/routes/pwa.ts`, `test/branding/manifest.test.ts` (15) | R13 to R15; ETag of the revision with 304; hostile names are one JSON string; ZWJ emoji at the cut stays whole; degraded mode; 307 and 404 |
| T-A-091 shell | `src/branding/shell.ts`, `test/branding/html-shell.test.ts` (26), `test/fixtures/shell-template.html` | six placeholders in one regex pass with a replacer function; names `__M365_NONCE__`, `$&`, `` $` ``, `$'` stay literal; title escaped; boot JSON escapes `<`, U+2028, U+2029; two nonces, two bodies; degraded mode |

Commands (single worker, `apps/server`): the four new files plus `branding-api`, `concurrency`, `audit-branding`: 234 passed; the full `test/branding` folder (16 files) 863 passed, 1 todo. `tsc -p tsconfig.json` 0 errors, `eslint src/branding test/branding test/fixtures --max-warnings 0` clean, `prettier --check` clean. `packages/shared` `single-implementation` 232 passed (one finding in the first draft of `shell.ts`, a hex-colour pattern, was removed: the theme colour is now checked with `tryNormalizeAccent`).

Mutation pass (one edit per run, the new test file of the task): 18 mutants (authorisation of unreferenced assets, name regex, cache class, 304, double replace pass, title escaping, `<` escape, degraded boot data, short name, theme colour, redirect status, forbidden key, duplicate key, depth limit, dry run, derived compact in export, BOM handling, `If-Match` on import). One survived first (the name regular expression of the asset route: the tests only used an unknown hash with a wrong suffix, not a registered one); a test with a registered hash and seven wrong suffixes now kills it. All 18 are killed.

**Honest note on test-first.** Each test file was written and run red (module not found) before its source; the tests then passed on the first or second run, so the mutation pass is what shows that they bite.

## 2. Interface for `T-A-092` (the module)

```ts
const transferDeps = { requireDatabase: deps.requireDatabase, now: deps.now, assets, images, service };
routes: [
  ...brandingRoutes({ service }), ...assetsUploadRoutes({ ... }),        // s2e
  ...exportImportRoutes(transferDeps),                                    // R10, R11
  ...assetServingRoutes({ requireDatabase: deps.requireDatabase, assets }), // R12
  ...pwaRoutes({ service }),                                              // R13 to R15
]
shell: createBrandingShell({
  template: deps.shellTemplate,
  service,                                   // get() is asked on every render; storage_unavailable means degraded
  me: (request) => ({ actor, permissions, features, version, publicOrigin, storageAvailable }), // see 3.1
})
```

All five factories take plain dependencies. `appliedBranding(service)` (in `manifest.ts`) is the shared "applied branding or `undefined` while degraded" helper.

## 3. Decisions the owner should know

1. **The shell needs `me`, and `ShellRenderer.render` only gets `{ nonce, request }`.** `createBrandingShell` therefore takes a `me(request)` callback. `T-A-092` must build it exactly as `GET /api/v1/me` does: the actor from `resolveActor(config, request)` (the same resolver the pipeline uses), the permissions in catalogue order, `features: { showcase, preview: actor.kind === 'preview' }`, `version`, `publicOrigin`, `storageAvailable: deps.storageAvailable()`. The inline copy of that mapping in `routes/meta.ts` is S1's; if S1 exports a builder `T-A-092` should call it (open point s2f-1).
2. **Degraded boot data is `{ "me": ..., "branding": null }`.** C8 says `{"me", "branding"}`; without storage there is no applied branding to embed, and the web reader (`readBootData`) already answers `null` and falls back to the API when `branding` does not validate. The theme CSS, title, theme colour and manifest link still come from the in-memory defaults and there are no icon links.
3. **Placeholders.** `__M365_BOOT_JSON__` is the JSON text only (the template owns the `<script ... id="m365-boot" nonce>` element), likewise the CSS, title and theme colour; `__M365_ICON_LINKS__` is two raw `<link>` tags (`icon` 32 and `apple-touch-icon` 180) built from `brandingAssetUrl(hash)` after an `isAssetHash` check. The manifest `<link>` is the template's own (chunk-s4b A-2). The nonce goes on every tag in the same pass. A nonce that is not base64 is refused with a `TypeError` (it lands in attributes).
4. **Service extension (outside the Files lines).** `apply()` of `service.ts` takes an optional `{ action: 'branding.import', detail }` so that the import commits through the same transaction as `PUT` and writes ONE audit entry, `branding.import` with `dryRun: false` and `schemaVersion: 1` (and the same revision/hash detail as an apply), instead of `branding.apply`. Default behaviour is unchanged (`branding-api`, `concurrency`, `audit-branding` still green). The alternative was a second copy of the commit logic.
5. **New test-support file** `test/branding/outputs-fixture.ts` (`createOutputsApp`): the fixture app of `branding-fixture.ts` with the routes under test added. `branding-fixture.ts` itself was not edited.
6. **Import parser.** `scanImportJson` (iterative, one pass) refuses repeated keys (decoded: `"a"` equals `"a"`), `__proto__`, `constructor`, `prototype`, and depth over 8 (the document is 3 deep) before `JSON.parse`. The body is decoded as strict UTF-8 with the byte order mark kept (so a BOM or invalid UTF-8 is `import_invalid`); `c.req.text()` would have stripped the BOM silently. `schemaVersion` of 2 or more (integer) or a text is `import_unsupported_version`; 0, negative, missing or another type is `import_invalid`. Structural faults have pointer `""`; schema faults use the pointers of the shared schema (`/orgName`, `/accent`, `/images/logoDark`); a pipeline refusal is re-thrown with `/images/<member>`.
7. **Import audit.** Success (dry run or applied): `branding.import`, `success`, detail `dryRun`, `schemaVersion`, `bytes`, plus the hash of each image for a dry run (an applied import has the apply detail). `rejected` (with the problem code) for `import_invalid`, `import_unsupported_version`, the image refusals and `staging_quota_exceeded`. Not audited: 412/428/422 for `If-Match` (header problems), 413 (the wrapper cut the body before the handler), 429, 503. A denied POST is the wrapper's `denied` entry.
8. **Image status codes.** `image_type_unsupported` is 415 on import as on upload (R7), not 422.
9. **Order in R11.** `If-Match` (non-dry-run) is judged before the body is read; a dry run ignores `If-Match` completely, even a stale one.
10. **Export of a missing master file.** `exportDocument` reads the master through the store; if the file is gone (`branding_asset_missing` case) the read throws `AssetFileMissingError` and the answer is a 500, not an export without that logo (silent loss of a logo seemed worse). Open point s2f-2.
11. **Manifest** `background_color` is `SURFACES.light.page`; `theme_color` is `tokens.light.accent` (the effective, possibly adjusted, light accent); the manifest is validated with the shared `WebManifestSchema` before it is sent. The ETag is the strong tag of the revision (`"0"` in degraded mode).
12. **Asset route** answers 503 `storage_unavailable` without storage (R12 lists 404 only for the cases of the name, the registry and the file); the 304 is built by the handler (the cache layer only does ETags for the fixed list of paths) and repeats `ETag` and `Cache-Control`.

## 4. Open points

| # | Point | Owner | When |
|---|---|---|---|
| s2f-1 | Wire the five factories and the shell as in section 2; the `me` callback (3.1) should use a shared builder if S1 exports one | S2 | `T-A-092` |
| s2f-2 | Decide whether an export with a missing master file should be a 500 (today) or a documented 409 | owner | any time |
| s2f-3 | `T-A-093` should run the H-35..H-44 checks over the real table; the import cases of H-42 and the names of H-43 are already proven here through the route pipeline | S2 | `T-A-093` |
| s2f-4 | `docs/security.md` (the import parser rules, the strict UTF-8 body, the single-pass shell fill, the asset headers) and `docs/api` for R10 to R15 | S8 | `T-A-274` onward |
| s2f-5 | `e2e/branding-xss.spec.ts` and `e2e/no-flash.spec.ts` (H-44) need the module wired and the real web build; not possible in this range | S7 | e2e tasks |
| s2f-6 | `VERSION` bump at commit time (protected path `apps/server/src/**`); no dependency file changed | orchestrator | commit |

## 5. Risks

- R1. The import holds the whole body (up to 9 MiB) as bytes and as a decoded string, plus the decoded images, in memory at once (about 40 MB peak); the `upload` rate class (3 burst) bounds how many run together.
- R2. The three images of an import are processed one after the other (child process each, 10 s budget each), so a worst-case import can take up to 30 s of image time; the runner's queue (4) is not at risk.
- R3. The `prototype` key is refused too (not in FR-A-093's list); a legitimate export never has it.
- R4. The shell fill assumes every `__M365_*__` placeholder of the template is one of the six; an unknown `__M365_X__` is left as it is.
