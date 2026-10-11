// The children of `job-runner.test.ts` (T-A-083). One script, one behaviour per `--mode=<name>`, so a
// test can start the runner against "a child that answers", "a child that crashes" or "a child that
// sends rubbish" without the real image pipeline. They speak the wire format of the job protocol
// (version 1, JSON over the IPC channel) by hand, so the test does not depend on the code it checks.
//
//   ok            answers at once with a valid upload reply
//   echo          answers with the bytes it was sent as the PNG (the bytes crossed the channel)
//   hold          answers when it receives SIGUSR2, so a test decides when a job ends
//   crash         exits with code 7 without answering
//   silent-exit   exits with code 0 without answering
//   garbage       sends a string that is not a reply
//   bad-code      answers with a failure code a worker is not allowed to send
//   problem       answers with the failure `image_corrupt`
//   internal      answers with an internal failure
//   bad-png       answers with a "PNG" that is not one
//   wrong-kind    answers a variants reply to an upload job
//   probe         answers a `{ ask: 'report' }` message with what the process can see and do
const mode = process.argv
  .find((argument) => argument.startsWith('--mode='))
  ?.slice('--mode='.length);

// A 1 by 1 PNG (red), as base64.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQI12M4IScHAAK2AQXlhWr1AAAAAElFTkSuQmCC';

const upload = (png = TINY_PNG) => ({
  v: 1,
  ok: true,
  kind: 'upload',
  png,
  width: 1,
  height: 1,
  luminance: 0.5,
  warnings: [],
});

function report(request) {
  const fs = process.getBuiltinModule('node:fs');
  const childProcess = process.getBuiltinModule('node:child_process');
  const workerThreads = process.getBuiltinModule('node:worker_threads');
  const attempt = (action) => {
    try {
      action();
      return 'allowed';
    } catch (failure) {
      return typeof failure === 'object' && failure !== null && 'code' in failure
        ? String(failure.code)
        : 'failed';
    }
  };
  return {
    pid: process.pid,
    env: Object.keys(process.env),
    execArgv: process.execArgv,
    argv: process.argv.slice(2),
    heapLimit: process.getBuiltinModule('node:v8').getHeapStatistics().heap_size_limit,
    permissionModel: process.permission !== undefined,
    mayRead: process.permission?.has('fs.read', request.canary) ?? null,
    mayReadEntry: process.permission?.has('fs.read', process.argv[1]) ?? null,
    mayWrite: process.permission?.has('fs.write', request.scratch) ?? null,
    readCanary: attempt(() => fs.readFileSync(request.canary)),
    writeScratch: attempt(() => fs.writeFileSync(request.scratch, 'x')),
    listDirectory: attempt(() => fs.readdirSync(request.directory)),
    spawn: attempt(() => childProcess.spawnSync(process.execPath, ['-e', '0'])),
    worker: attempt(() => {
      new workerThreads.Worker('0', { eval: true }).terminate();
    }),
  };
}

// `hold` waits for two things, in either order: its request and SIGUSR2. The handler is installed when
// the script loads (a signal without a handler would end the process), and a test only signals a child
// whose handler is installed: it reads the caught-signal mask of the process from /proc.
const held = { request: undefined, released: false };

function answerIfReleased() {
  if (held.request !== undefined && held.released) process.send(upload());
}

if (mode === 'hold') {
  process.on('SIGUSR2', () => {
    held.released = true;
    answerIfReleased();
  });
}

process.on('message', (request) => {
  switch (mode) {
    case 'ok':
      process.send(upload());
      break;
    case 'echo':
      process.send(upload(request.bytes));
      break;
    case 'hold':
      // The signal may have come first: it is remembered at load time (see below).
      held.request = request;
      answerIfReleased();
      break;
    case 'crash':
      process.exit(7);
      break;
    case 'silent-exit':
      process.exit(0);
      break;
    case 'garbage':
      process.send('this is not a reply');
      break;
    case 'bad-code':
      process.send({ v: 1, ok: false, failure: 'problem', code: 'permission_denied' });
      break;
    case 'problem':
      process.send({ v: 1, ok: false, failure: 'problem', code: 'image_corrupt' });
      break;
    case 'internal':
      process.send({ v: 1, ok: false, failure: 'internal' });
      break;
    case 'bad-png':
      process.send(upload(Buffer.from('this is not a png at all').toString('base64')));
      break;
    case 'wrong-kind':
      process.send({
        v: 1,
        ok: true,
        kind: 'variants',
        compact: null,
        compactDerived: false,
        source: 'monogram',
        plate: 'accent',
        icons: {},
      });
      break;
    case 'probe':
      process.send(report(request));
      break;
    default:
      process.exit(3);
  }
});
