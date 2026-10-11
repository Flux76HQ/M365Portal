// The image child process (T-A-083; FR-A-097; PD-08, V-19). Started by the job runner, one per job: it
// reads one request from the IPC channel, does the job, writes one reply and exits. It starts with an
// empty environment, has no standard streams, opens no file (it runs under the permission model of
// Node with read access to its own bundle and `node_modules` only), makes no connection and has no
// code that could. The file name matches the `*-worker.ts` rule of the server build (TA-09), which
// bundles it as `dist/image-worker.js` next to `dist/index.js`.
//
// It stops when its parent goes away: the end of the IPC channel is its only signal then (a parent
// that was killed cannot say anything), so it exits at once, so a crash of the server leaves no
// image process behind. A job that never ends is not this file's business: the runner kills it.
import { handleJob } from './pipeline/job-handler.js';
import { parseJobRequest } from './pipeline/job-protocol.js';
import { processUpload } from './pipeline/process-upload.js';
import { configureSharp } from './pipeline/raster.js';

// One thread and no cache: a child does one job, and the memory budget counts every byte it holds.
configureSharp();

function main(): void {
  // Not started by a parent that talks to it: nothing to do.
  if (process.send === undefined) process.exit(2);
  // The parent went away before this code ran (or while the bundle was loading).
  if (!process.connected) process.exit(0);
  process.once('disconnect', () => {
    process.exit(0);
  });

  process.once('message', (raw: unknown) => {
    void (async () => {
      let reply;
      try {
        reply = await handleJob(parseJobRequest(raw), { upload: processUpload });
      } catch {
        reply = { v: 1, ok: false, failure: 'internal' } as const;
      }
      process.send?.(reply, (failure: Error | null) => {
        process.exit(failure === null ? 0 : 1);
      });
    })();
  });
}

main();
