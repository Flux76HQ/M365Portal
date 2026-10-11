# ADR-0034: Image work runs in one fresh child process per job (PD-08)

Samenvatting (NL): Beeldverwerking draait per taak in een nieuw kindproces dat na 10 s met SIGKILL wordt gestopt.

## Status

Plan

Source: plan section 6.2, row PD-08.

## Context

V-19: `worker.terminate()` does not stop a native libvips or librsvg call already running. The thread kept a full core busy until the job ended by itself, so a worker thread cannot enforce a time budget and zombie jobs would pile up in the shared libuv pool.

## Decision

`child_process.fork` of `dist/image-worker.js` per job with an empty environment, `stdio` limited to the IPC channel and `--max-old-space-size=128`. Two jobs run at once, four wait (a fifth gets 429 `image_processing_busy`), and the child is killed with SIGKILL after 10 s (`image_processing_timeout`). sharp is configured with `cache(false)` and `concurrency(1)`. esbuild emits `image-worker.js` as a separate entry (TA-09).

## Consequences

Starting a child and loading sharp takes about 230 ms and 75 MB resident per child, irrelevant for a rare admin action but counted in the memory budget (PR-15). In the image, idle RSS is 116 to 129 MB and peak RSS 147 to 167 MB after two concurrent 4096 by 4096 uploads.

## Evidence

- Plan 6.2 row PD-08; V-19 (measured: killed at 2,015 ms against a 2,000 ms budget, process gone).
- `G2.md` section 2.1: the built server ran the image worker under Node's permission model.
- `G6.md`: locating `dist/image-worker.js` from the bundle on distroless, which the plan marked UNVERIFIED, is covered by the smoke test (21 of 21, "image worker file present"); memory figures from the same run (PR-15).
