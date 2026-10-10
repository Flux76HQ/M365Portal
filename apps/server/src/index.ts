import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { formatConfigIssues, loadConfig } from './config/index.js';
import { APP_VERSION } from './version.js';

// Plan 7.1 step 1: validate the configuration before anything else. An invalid configuration
// prints the variable names (never the values) and exits 1 without opening a port.
const loaded = loadConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(formatConfigIssues(loaded.issues));
  process.exit(1);
}
const { config } = loaded;

const server = serve(
  { fetch: createApp().fetch, port: config.port, hostname: config.host },
  (info) => {
    console.info(`m365portal ${APP_VERSION} listening on ${info.address}:${String(info.port)}`);
  },
);

// tsx watch restarts, Playwright and Docker all stop the process with SIGTERM or SIGINT.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
