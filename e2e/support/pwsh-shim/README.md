# The `pwsh` shim (Phase D, e2e topology)

`pwsh` in this directory is a stand-in for PowerShell, for the e2e topology only. With this directory FIRST on the
`PATH` of the server process, the product's own command lookup (`resolveCommand` in
`apps/server/src/integrations/exchange/runtime.ts`) finds it instead of PowerShell, and the Exchange worker becomes
the fake: `apps/server/test/fakes/fake-tenant/exchange/standin-process.mjs --semantic`. It speaks the real line
protocol of `worker-script.ps1` over the fake Exchange state, so lists and contacts can be exercised end to end.
The image never contains it, and the product has no test hook for it: it is only a file found on a `PATH`.

## How e2e starts the server with it

1. Make a run directory (for example `<runDir>/pwsh/`) and put in it:
   - a symlink `pwsh` to `e2e/support/pwsh-shim/pwsh`;
   - a symlink `node` to the Node binary that runs the server (`process.execPath`). The product starts the worker with
     a short environment WITHOUT a `PATH`, so the shim cannot look `node` up; it uses the link next to it;
   - optionally `seed.json` (below).
2. Start the server with `PATH=<runDir>/pwsh:$PATH` in its environment (only the server process; the run
   directory is the one `PATH` entry in front). The worker is started lazily, at the first Exchange request.
3. The key hand-over is the product's own: the stand-in receives the certificate and the PKCS#8 key as PEM in
   the `connect` line and refuses (`permission_denied`) a key that does not belong to the certificate, so the real
   credential flow from the sealed store is exercised, not bypassed.

## Data

- Without `seed.json`: three people, three lists (`Marketing` and `Sales` managed by the panel, `Legacy synced`
  read-only), two contacts. See `DEFAULT_SEED` in `standin-seed.ts`.
- `seed.json` next to the link (format in `standin-seed.ts`): recipients (with `externalDirectoryObjectId` to match
  users of the fake Graph), contacts, groups with members, `bulk` for many rows (`{ "bulk": { "groups": 4000 } }`
  makes a list result too large for one answer line, which the list API turns into 422 `narrow_search`),
  `connect` (`{ "error": "role_pending" }` makes the connect fail with that code), and the switches of the fake.
- The seed is read on every request: rewriting `seed.json` replaces the data at once. That is the reseed
  between tests; no restart is needed.
- Writes (members, contacts) survive the recycling of the worker process: they are kept in a journal in the
  temporary directory (`m365portal-standin-<server pid>.ndjson`), replayed over the seed, emptied on a reseed, and
  swept when the server is gone.

`apps/server/test/exchange/pwsh-shim.test.ts` drives the shim the way the product does and is the reference
for what it guarantees.
