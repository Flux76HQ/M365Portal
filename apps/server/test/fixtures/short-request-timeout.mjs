// Preloaded into a BUILT server process (`NODE_OPTIONS=--import=<this file>`) by the hostile-corpus
// test of the slow upload (H-37). The server's HTTP limits are fixed constants (FR-A-025) and
// deliberately not configurable, so the test shortens `requestTimeout` from outside, in the process:
// every `http.createServer` call gets the numbers of the environment variables below, nothing else
// changes. Used by tests only; nothing in `src` or in the image refers to it.
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const requestTimeout = Number(process.env.M365_TEST_REQUEST_TIMEOUT_MS);
const connectionsCheckingInterval = Number(process.env.M365_TEST_CHECK_INTERVAL_MS);
const original = http.createServer;

http.createServer = function createServer(...args) {
  const first = args[0];
  const options = typeof first === 'object' && first !== null ? args.shift() : {};
  return original.call(
    this,
    {
      ...options,
      requestTimeout,
      // Node refuses a headersTimeout above the requestTimeout.
      headersTimeout: Math.min(options.headersTimeout ?? requestTimeout, requestTimeout),
      connectionsCheckingInterval,
    },
    ...args,
  );
};
syncBuiltinESMExports();
