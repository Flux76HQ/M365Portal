// T-D-113, FR-D-107 (+ negative): nothing a person's name, address or alias could be reaches a log.
// The worker's input and output are never logged; the only fields are the request id, the cmdlet
// name, the outcome, the duration and the retry facts. Two halves: a run with canary values through
// every client method (success, command error, throttling, crash), and a scan of the source that
// reads the keys of every log call.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCHANGE_CMDLETS } from '@m365portal/shared/exchange/allow-list';
import { expectGuardFails } from '@m365portal/shared/testing';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { rejectionOf } from '../integrations/support.js';
import { clientHarness } from './support.js';

/** The keys a log call of the Exchange code may carry. */
const ALLOWED_KEYS = new Set([
  'event',
  'requestId',
  'cmdlet',
  'outcome',
  'durationMs',
  'attempt',
  'reason',
  'waitMs',
  'code',
  'launches',
]);
const OUTCOMES = new Set([
  'ok',
  'command_error',
  'throttled',
  'timeout',
  'crashed',
  'refused',
  'protocol',
]);

const CANARIES = [
  'Zoë CANARYNAME',
  'canary.address@canary-domain.example',
  'canaryalias',
  'CANARYFIRST',
  'CANARYLAST',
] as const;

interface Entry {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function checkEntries(entries: readonly Entry[]): void {
  const text = JSON.stringify(entries);
  for (const canary of CANARIES) {
    if (text.includes(canary)) throw new Error(`a canary reached the log: ${canary}`);
  }
  for (const entry of entries) {
    for (const key of Object.keys(entry.fields)) {
      if (!ALLOWED_KEYS.has(key)) throw new Error(`a log field outside the list: ${key}`);
    }
    const { cmdlet, outcome } = entry.fields;
    if (cmdlet !== undefined && !(EXCHANGE_CMDLETS as readonly unknown[]).includes(cmdlet)) {
      throw new Error('a log entry names something that is not an allow-listed cmdlet');
    }
    if (outcome !== undefined && !(typeof outcome === 'string' && OUTCOMES.has(outcome))) {
      throw new Error('an outcome outside the list');
    }
  }
}

describe('a run with canary values through every method', () => {
  it('logs request id, cmdlet, outcome and duration, and no canary', async () => {
    const h = clientHarness();
    const group = h.state.addDistributionGroup({
      name: 'Marketing',
      primarySmtpAddress: 'marketing@contoso-fake.example',
    });
    const person = h.state.addRecipient({
      displayName: CANARIES[0],
      primarySmtpAddress: CANARIES[1],
    });
    await h.drive(h.client.addDistributionGroupMember(group.guid, person.guid));
    await h.drive(h.client.listDistributionGroups({ prefix: CANARIES[0] }));
    const created = await h.drive(
      h.client.createMailContact({
        name: 'Zoe-a1b2c3',
        displayName: CANARIES[0],
        alias: CANARIES[2],
        externalEmailAddress: 'canary.contact@canary-domain.example',
        firstName: CANARIES[3],
        lastName: CANARIES[4],
      }),
    );
    await h.drive(h.client.updateMailContact(created.guid, { displayName: `${CANARIES[0]} 2` }));
    await h.drive(h.client.listMailContacts({ prefix: CANARIES[0] }));
    await h.drive(h.client.removeMailContact(created.guid));
    // A command error, throttling and a crash, each with canary values in the arguments.
    await rejectionOf(
      h.drive(h.client.addDistributionGroupMember(group.guid, 'unknown.person@elsewhere.example')),
    );
    h.launcher.script((call) =>
      call.index === h.launcher.calls() ? { error: 'throttled', retryAfterMs: 1_000 } : undefined,
    );
    await h.drive(h.client.listMailContacts({ prefix: CANARIES[0] }));
    h.launcher.script((call) => (call.index === h.launcher.calls() ? 'exit' : undefined));
    await h.drive(h.client.listMailContacts({ prefix: CANARIES[0] }));
    expect(h.log.entries.length).toBeGreaterThan(8);
    expect(() => {
      checkEntries(h.log.entries);
    }).not.toThrow();
    const calls = h.log.entries.filter((entry) => entry.fields.event === 'exchange_call');
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call.fields.requestId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      expect(typeof call.fields.durationMs).toBe('number');
    }
  });

  it('puts no canary in an error: not in the message, JSON, string or inspect form', async () => {
    const h = clientHarness();
    const failure = await rejectionOf(
      h.drive(h.client.addDistributionGroupMember('nobody@contoso-fake.example', CANARIES[1])),
    );
    const forms = [String(failure), JSON.stringify(failure), (failure as Error).message];
    for (const form of forms) for (const canary of CANARIES) expect(form).not.toContain(canary);
  });

  it('negative: a log entry that carries arguments, or an unknown key, fails the guard', () => {
    expectGuardFails(
      checkEntries,
      [{ level: 'debug', fields: { event: 'exchange_call', identity: 'someone' }, message: 'x' }],
      { name: 'unknown key', reason: 'a log field outside the list: identity' },
    );
    expectGuardFails(
      checkEntries,
      [{ level: 'warn', fields: { event: 'exchange_call' }, message: `failed for ${CANARIES[0]}` }],
      { name: 'canary in the message', reason: 'a canary reached the log' },
    );
    expectGuardFails(
      checkEntries,
      [{ level: 'warn', fields: { event: 'exchange_call', cmdlet: 'Get-Mailbox' }, message: 'x' }],
      { name: 'foreign cmdlet', reason: 'not an allow-listed cmdlet' },
    );
  });
});

const PWSH_DIR = fileURLToPath(new URL('../../src/integrations/exchange/pwsh/', import.meta.url));

/** Every `log.debug/info/warn({...})` call of a source: the keys of its first argument. */
function logKeys(text: string): { keys: string[]; computed: boolean }[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const out: { keys: string[]; computed: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['debug', 'info', 'warn', 'error'].includes(node.expression.name.text) &&
      /\blog\b/.test(node.expression.expression.getText(source))
    ) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isObjectLiteralExpression(first)) {
        out.push({
          keys: first.properties.map((property) =>
            ts.isSpreadAssignment(property) ? '...' : property.name.getText(source),
          ),
          computed: first.properties.some((property) => ts.isSpreadAssignment(property)),
        });
      } else {
        out.push({ keys: ['<not an object literal>'], computed: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function checkSourceLogs(files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) {
    for (const call of logKeys(text)) {
      const bad = call.keys.filter((key) => !ALLOWED_KEYS.has(key));
      if (bad.length > 0) throw new Error(`${name}: a log call with the key ${bad.join(', ')}`);
    }
  }
}

describe('the source of the worker code', () => {
  const files = Object.fromEntries(
    readdirSync(PWSH_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(join(PWSH_DIR, name), 'utf8')]),
  );

  it('has log calls with allowed keys only', () => {
    expect(Object.keys(files)).toContain('pwsh-client.ts');
    expect(() => {
      checkSourceLogs(files);
    }).not.toThrow();
    const total = Object.values(files).reduce((n, text) => n + logKeys(text).length, 0);
    expect(total).toBeGreaterThan(2);
  });

  it('has no console call and no direct stderr or stdout write', () => {
    for (const [name, text] of Object.entries(files)) {
      expect(text, name).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
      expect(text, name).not.toMatch(/process\.(stdout|stderr)\.write/);
    }
  });

  it('negative: a log call with the arguments, or with a spread, fails the scan', () => {
    expectGuardFails(
      checkSourceLogs,
      { 'x.ts': 'log.debug({ event: "exchange_call", args }, "call");' },
      { name: 'args', reason: 'a log call with the key args' },
    );
    expectGuardFails(
      checkSourceLogs,
      { 'x.ts': 'this.log?.warn({ ...fields }, "retry");' },
      { name: 'spread', reason: 'a log call with the key ...' },
    );
    expectGuardFails(
      checkSourceLogs,
      { 'x.ts': 'log.warn(fields, "retry");' },
      { name: 'not a literal', reason: '<not an object literal>' },
    );
  });
});
