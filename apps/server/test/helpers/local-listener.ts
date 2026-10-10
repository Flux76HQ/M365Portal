// A listener on 127.0.0.1 that counts connections.
//
// The hostile corpus points every external reference of a payload (`<image href>`, `@import`,
// an external entity, an `xml-stylesheet`) at this listener. FR-A-088 says no outbound connection
// is made while an upload is processed; the proof is that this listener has accepted none. It
// counts connections, not requests: a bare TCP connect already counts.
//
// It answers whatever arrives with an empty 404, so a client that does connect finishes quickly
// instead of waiting for a body.
import { createServer, type Socket } from 'node:net';
import { afterCurrentTest } from './temp-data-dir.js';

export interface LocalListener {
  /** `http://127.0.0.1:<port>`: the origin payloads point at. No trailing slash. */
  readonly origin: string;
  readonly port: number;
  /** Connections accepted since the listener started or was last reset. */
  connections(): number;
  /** The first line each connection sent, such as `GET /x.png HTTP/1.1`; for failure messages. */
  requestLines(): string[];
  /** Forget what was counted. */
  reset(): void;
  /** Stop listening and drop open connections. Safe to call twice. */
  close(): Promise<void>;
}

const ANSWER = 'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const MAX_REQUEST_LINE_BYTES = 512;

export async function startLocalListener(): Promise<LocalListener> {
  let seen: { line: string }[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    const entry = { line: '' };
    seen.push(entry);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {
      // A client that goes away mid-request is not a failure of the listener.
    });
    socket.once('data', (chunk: Buffer) => {
      const head = chunk.subarray(0, MAX_REQUEST_LINE_BYTES).toString('latin1');
      entry.line = head.split('\r\n')[0] ?? '';
      socket.end(ANSWER);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the listener has no port');

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        resolve();
      });
    });
    return closing;
  };
  afterCurrentTest(close);

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    connections: () => seen.length,
    requestLines: () => seen.map((entry) => entry.line).filter((line) => line !== ''),
    reset: () => {
      seen = [];
    },
    close,
  };
}
