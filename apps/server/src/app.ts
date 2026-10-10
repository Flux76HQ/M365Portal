import { Hono } from 'hono';
import { APP_VERSION } from './version.js';

/** Build the HTTP application. Every route is registered here; this is the unit under test. */
export function createApp(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok', version: APP_VERSION }));

  return app;
}
