// What the page and the service worker agree on. Imported by both sides, so it holds constants only.

/** The one URL the worker is served from, and the only one the Trusted Types policy lets through. */
export const SERVICE_WORKER_PATH = '/sw.js';

/** The message the page sends to a waiting worker after the person accepted "Update available". */
export const SKIP_WAITING_MESSAGE = 'SKIP_WAITING';
