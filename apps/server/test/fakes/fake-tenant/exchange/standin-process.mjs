// The process-level worker stand-in (T-D-112): a small Node program that speaks the line protocol of
// `@m365portal/shared/exchange/protocol` on stdin and stdout, with no dependency on the repository.
// It is what `createNodeWorkerLauncher` spawns in the tests that need a real child process (pipes,
// environment, exit, kill). The semantic stand-in (member types, duplicates, the manager check) is
// `worker-standin.ts`; this one only proves the transport.
//
// It answers: ping (with the environment names and the arguments it was started with), connect (and
// writes the certificate data to STDERR, which the launcher must throw away), shutdown (and exits),
// and a call whose `Identity` argument asks for a behaviour: `split` writes a multi-byte character
// in two chunks, `hang` never answers, `crash` exits with status 3, `noise` prints a banner first.
//
// With `--semantic` as the FIRST argument it is the other stand-in instead: the whole worker protocol over
// the fake Exchange state, with seedable data (`standin-semantic.ts`, loaded through tsx). That is what the
// `pwsh` shim of the e2e topology runs (`e2e/support/pwsh-shim/pwsh`); the arguments after `--semantic` are
// the ones the product gives `pwsh` (`-File <script> -CertificateMode <mode> [-ScratchDirectory <dir>]`).
import { argv, env, exit, stderr, stdin, stdout } from 'node:process';

if (argv[2] === '--semantic') {
  // The TypeScript sources of the fake are loaded through tsx, found from this file's location.
  const { register } = await import('tsx/esm/api');
  register();
  const { runSemanticStandIn } = await import('./standin-semantic.ts');
  runSemanticStandIn(argv.slice(3));
} else {
  runTransportStandIn();
}

function runTransportStandIn() {
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handle(line);
    }
  });
  stdin.on('end', () => exit(0));
}

function reply(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    stdout.write('not json\n');
    return;
  }
  if (message.type === 'ping') {
    reply({
      v: 1,
      id: message.id,
      ok: true,
      data: { pong: true, env: Object.keys(env).sort(), argv: argv.slice(2) },
    });
  } else if (message.type === 'connect') {
    stderr.write(`CANARY-STDERR ${message.certificate.privateKey}\n`);
    reply({ v: 1, id: message.id, ok: true, data: {} });
  } else if (message.type === 'shutdown') {
    reply({ v: 1, id: message.id, ok: true, data: {} });
    exit(0);
  } else if (message.type === 'call') {
    const behaviour = message.args?.Identity;
    if (behaviour === 'hang') return;
    if (behaviour === 'crash') exit(3);
    if (behaviour === 'noise') stdout.write('WARNING: a banner\n');
    if (behaviour === 'split') {
      const text = `${JSON.stringify({ v: 1, id: message.id, ok: true, data: { word: 'café €' } })}\n`;
      const bytes = Buffer.from(text, 'utf8');
      const cut = bytes.indexOf(0xe2) + 1; // inside the three bytes of the euro sign
      stdout.write(bytes.subarray(0, cut));
      setTimeout(() => stdout.write(bytes.subarray(cut)), 20);
      return;
    }
    reply({ v: 1, id: message.id, ok: true, data: { rows: [] } });
  }
}
