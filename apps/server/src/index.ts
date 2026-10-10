import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { readListenOptions } from './listen.js';
import { APP_VERSION } from './version.js';

const { port, hostname } = readListenOptions(process.env);

const server = serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.info(`m365portal ${APP_VERSION} listening on ${info.address}:${String(info.port)}`);
});

// tsx watch restarts, Playwright and Docker all stop the process with SIGTERM or SIGINT.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
