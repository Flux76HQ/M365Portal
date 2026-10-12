// Every message the server, the registries or the schemas can name exists in both catalogues, with the
// same placeholders (T-B-292; FR-B-603, FR-B-604, TB-13).
//
// The server sends keys and parameters, never translated text, and the web app turns them into text.
// A key that a registry names and the catalogue lacks would show on screen as the key itself, so this
// test walks every registry that produces a key:
//   problem codes            problem.<code>                       (problem.ts)
//   wizard result codes      setup.result.<code>, setup.remedy.<code>   (setup/result-codes.ts)
//   `errors[]` detail codes  see i18n/detail-codes.ts
//   sign-in error codes      signin.error.<code>, signin.remedy.<code>  (auth/signin-errors.ts)
//   no-access reasons        noaccess.reason.<reason>, noaccess.remedy.<reason>
//   rollback hints           setup.hint.<name>                    (setup/steps.ts)
//   wizard log lines         setup.log.<name>                     (setup/log-keys.ts)
//   steps, sub-actions, statuses, object kinds, run statuses, proof keys and statuses, certificate levels
//   roles, permissions, qualifiers, resource types, scope items, origins   (rbac/labels.ts)
//   the session notices of the shell (below)
// and checks four things for each: the key exists in `en` and in `nl`, the two messages use the same
// placeholders, a log line uses only the parameters its key declares, and the rollback hints name the
// parameters the wizard fills in. It also runs the other way: a message in a namespace that a registry
// owns without a registry entry is a leftover (a code that was removed keeps its text otherwise).
//
// Every guard here is run on input that breaks it (expectGuardFails).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIGNIN_ERROR_CODES, NO_ACCESS_REASONS } from '../src/auth/signin-errors.js';
import { ERROR_DETAIL_CODES, ERROR_DETAIL_MESSAGE_KEYS } from '../src/i18n/detail-codes.js';
import { LAZY_NAMESPACES, LOCALES, placeholdersOf, type Locale } from '../src/i18n/index.js';
import { PROBLEM_CODES, problemMessageKey } from '../src/problem.js';
import { ALL_LABEL_KEYS } from '../src/rbac/labels.js';
import {
  PROOF_KEYS,
  PROOF_STATUSES,
  CERTIFICATE_LEVELS,
  RUN_STATUSES,
  SECRETS_STATUSES,
  DEVICE_CODE_STATES,
} from '../src/schemas/connection.js';
import { LOG_KEYS } from '../src/setup/log-keys.js';
import {
  ENVIRONMENT_CHECK_KEYS,
  ENVIRONMENT_CHECK_STATUSES,
  RESULT_CODES,
  resultMessageKey,
  resultRemedyKey,
} from '../src/setup/result-codes.js';
import {
  ROLLBACK_HINT_KEYS,
  SETUP_OBJECT_KINDS,
  STEP_KEYS,
  STEP_STATUSES,
  SUB_ACTION_KEYS,
  stepMessageKey,
  subActionMessageKey,
} from '../src/setup/steps.js';
import { expectGuardFails } from '../src/testing/index.js';

const localesDirectory = fileURLToPath(new URL('../src/i18n/locales', import.meta.url));

type Messages = Readonly<Record<string, string>>;
type Catalogues = Readonly<Record<Locale, Messages>>;

/** The entry catalogue plus every lazy file of one language: all the text the application can show. */
function readMessages(locale: Locale): Messages {
  const merged: Record<string, string> = JSON.parse(
    readFileSync(join(localesDirectory, `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
  for (const name of readdirSync(join(localesDirectory, 'lazy')).sort()) {
    if (!name.endsWith(`.${locale}.json`)) continue;
    Object.assign(
      merged,
      JSON.parse(readFileSync(join(localesDirectory, 'lazy', name), 'utf8')) as Record<
        string,
        string
      >,
    );
  }
  return merged;
}

const CATALOGUES: Catalogues = {
  en: readMessages('en'),
  nl: readMessages('nl'),
};

/** What a registry requires of one message. */
interface Required {
  readonly key: string;
  /** Where the key comes from, for the failure message. */
  readonly source: string;
  /** When set, the placeholders of the message must be exactly this set... */
  readonly exactParams?: readonly string[];
  /** ...or at most these. */
  readonly allowedParams?: readonly string[];
}

const SESSION_KEYS: readonly string[] = [
  'session.actor.setup',
  'session.actor.breakGlass',
  'session.persona.menuLabel',
  'session.menu.myAccess',
  'session.menu.signOut',
  'session.menu.signOutAll',
  'session.menu.signingOut',
  'session.menu.signOutFailed',
  'session.idle.title',
  'session.idle.message',
  'session.idle.extend',
  'session.idle.signOut',
  'session.idle.extendFailed',
  'session.expiry.notice',
  'session.expiry.region',
  'session.stepUp.title',
  'session.stepUp.message',
  'session.stepUp.confirm',
  'session.stepUp.cancel',
  'session.close',
  'session.breakGlass.title',
  'session.breakGlass.message',
  'session.breakGlass.remaining',
  'session.groupsStale.title',
  'session.groupsStale.message',
];

/** What the wizard fills in for each rollback hint (plan 9.13); `setup.hint.bootstrap_consent` takes none. */
const HINT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'setup.hint.application': ['name', 'objectId', 'appId'],
  'setup.hint.service_principal': ['objectId'],
  'setup.hint.certificate': ['thumbprint', 'appObjectId'],
  'setup.hint.grants': ['roles'],
  'setup.hint.exchange_role': ['role'],
  'setup.hint.bootstrap_consent': [],
};

/** Everything the registries name, as the messages they require. */
function requiredMessages(): Required[] {
  const required: Required[] = [];
  const add = (
    key: string,
    source: string,
    params?: Partial<Pick<Required, 'exactParams' | 'allowedParams'>>,
  ) => {
    required.push({ key, source, ...params });
  };
  for (const code of Object.keys(PROBLEM_CODES))
    add(problemMessageKey(code), `problem code ${code}`);
  add(problemMessageKey('not-a-code'), 'the fallback for an unknown problem code');
  for (const code of RESULT_CODES) {
    add(resultMessageKey(code), `result code ${code}`);
    add(resultRemedyKey(code), `result code ${code} (remedy)`);
  }
  for (const code of ERROR_DETAIL_CODES) {
    add(ERROR_DETAIL_MESSAGE_KEYS[code], `errors[] detail code ${code}`);
  }
  for (const code of SIGNIN_ERROR_CODES) {
    add(`signin.error.${code}`, `sign-in code ${code}`);
    add(`signin.remedy.${code}`, `sign-in code ${code} (remedy)`);
  }
  for (const reason of NO_ACCESS_REASONS) {
    add(`noaccess.reason.${reason}`, `no-access reason ${reason}`);
    add(`noaccess.remedy.${reason}`, `no-access reason ${reason} (remedy)`);
  }
  for (const key of ROLLBACK_HINT_KEYS) {
    add(key, 'rollback hint', { exactParams: HINT_PARAMS[key] ?? [] });
  }
  for (const [key, names] of Object.entries(LOG_KEYS)) {
    add(key, 'wizard log line', { allowedParams: names });
  }
  for (const step of STEP_KEYS) add(stepMessageKey(step), `step ${step}`);
  for (const sub of SUB_ACTION_KEYS) add(subActionMessageKey(sub), `sub-action ${sub}`);
  for (const status of STEP_STATUSES) add(`setup.status.${status}`, `step status ${status}`);
  for (const status of RUN_STATUSES) add(`setup.runStatus.${status}`, `run status ${status}`);
  for (const kind of [...SETUP_OBJECT_KINDS, 'certificate'])
    add(`setup.kind.${kind}`, `object kind ${kind}`);
  for (const check of ENVIRONMENT_CHECK_KEYS)
    add(`setup.checkOk.${check}`, `environment check ${check} (ok)`);
  for (const status of ENVIRONMENT_CHECK_STATUSES)
    add(`setup.check.${status}`, `environment check status ${status}`);
  for (const state of DEVICE_CODE_STATES)
    add(`setup.deviceState.${state}`, `device-code state ${state}`);
  for (const key of PROOF_KEYS) add(`connection.proof.${key}`, `proof item ${key}`);
  for (const status of PROOF_STATUSES)
    add(`connection.proofStatus.${status}`, `proof status ${status}`);
  for (const level of CERTIFICATE_LEVELS)
    add(`connection.certificate.level.${level}`, `certificate level ${level}`);
  for (const status of SECRETS_STATUSES)
    add(`connection.secrets.${status}`, `secrets status ${status}`);
  for (const key of ALL_LABEL_KEYS) add(key, 'label registry');
  for (const key of SESSION_KEYS) add(key, 'session notice');
  return required;
}

/** The problems of one language against what is required. */
function checkMessageKeys(required: readonly Required[], catalogues: Catalogues): string[] {
  const problems: string[] = [];
  for (const { key, source, exactParams, allowedParams } of required) {
    const placeholders: Record<string, readonly string[]> = {};
    for (const locale of LOCALES) {
      const message = catalogues[locale][key];
      if (message === undefined || message.trim() === '') {
        problems.push(`${locale}: no message for "${key}" (${source})`);
        continue;
      }
      placeholders[locale] = placeholdersOf(message);
    }
    const en = placeholders.en;
    const nl = placeholders.nl;
    if (en !== undefined && nl !== undefined && [...en].sort().join() !== [...nl].sort().join()) {
      problems.push(
        `"${key}" uses different placeholders in en ({${en.join(', ')}}) and nl ({${nl.join(', ')}})`,
      );
    }
    for (const [locale, names] of Object.entries(placeholders)) {
      if (
        exactParams !== undefined &&
        [...names].sort().join() !== [...exactParams].sort().join()
      ) {
        problems.push(
          `${locale}: "${key}" must use exactly {${exactParams.join(', ')}} (${source}), it uses {${names.join(', ')}}`,
        );
      }
      if (allowedParams !== undefined) {
        const stray = names.filter((name) => !allowedParams.includes(name));
        if (stray.length > 0) {
          problems.push(
            `${locale}: "${key}" uses {${stray.join(', ')}}, which the key does not declare (${source}): it declares {${allowedParams.join(', ')}}`,
          );
        }
      }
    }
  }
  return problems;
}

function assertMessageKeys(
  required: readonly Required[],
  catalogues: Catalogues = CATALOGUES,
): void {
  const problems = checkMessageKeys(required, catalogues);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

// ---------------------------------------------------------------------------------------------

describe('every key a registry names has a message in both languages', () => {
  const required = requiredMessages();

  it('names a substantial set of keys (the walk is not vacuous)', () => {
    const keys = new Set(required.map((entry) => entry.key));
    expect(keys.size).toBeGreaterThan(300);
    for (const sample of [
      'problem.setup_token_invalid',
      'setup.result.device_code_blocked',
      'setup.remedy.application_untrusted',
      'signin.error.mfa_required',
      'signin.remedy.amr_missing',
      'noaccess.reason.graph_unavailable',
      'setup.hint.bootstrap_consent',
      'setup.log.drift_found',
      'setup.log.role_fixture_mismatch',
      'role.owner',
      'permission.rbac:manage',
      'scope.prefix.displayName',
      'origin.group',
      'access.error.privileged_role_group',
      'session.idle.extend',
    ]) {
      expect(keys.has(sample), sample).toBe(true);
    }
  });

  it('finds a message for each key, in en and in nl, with the same placeholders', () => {
    expect(checkMessageKeys(required, CATALOGUES)).toEqual([]);
    expect(() => {
      assertMessageKeys(required);
    }).not.toThrow();
  });

  it('covers every problem code, wizard result code, sign-in code and no-access reason of the registries', () => {
    const keys = new Set(required.map((entry) => entry.key));
    for (const code of Object.keys(PROBLEM_CODES))
      expect(keys.has(`problem.${code}`), code).toBe(true);
    for (const code of RESULT_CODES) {
      expect(keys.has(`setup.result.${code}`), code).toBe(true);
      expect(keys.has(`setup.remedy.${code}`), code).toBe(true);
    }
    for (const code of SIGNIN_ERROR_CODES) {
      expect(keys.has(`signin.error.${code}`), code).toBe(true);
      expect(keys.has(`signin.remedy.${code}`), code).toBe(true);
    }
    for (const reason of NO_ACCESS_REASONS)
      expect(keys.has(`noaccess.reason.${reason}`), reason).toBe(true);
  });

  it('has a message for the errors[] detail codes privileged_role_group, principal_disabled and owner_changed', () => {
    expect([...ERROR_DETAIL_CODES].sort()).toEqual([
      'owner_changed',
      'principal_disabled',
      'privileged_role_group',
    ]);
    for (const code of ERROR_DETAIL_CODES) {
      for (const locale of LOCALES) {
        expect(
          CATALOGUES[locale][ERROR_DETAIL_MESSAGE_KEYS[code]],
          `${locale}: ${code}`,
        ).toBeTruthy();
      }
    }
  });

  it('names the AUTH_REQUIRE_MFA switch and the optional claim amr where the sign-in codes need them (FR-B-405, EB-26, EB-27)', () => {
    for (const locale of LOCALES) {
      const text = (key: string): string => CATALOGUES[locale][key] ?? '';
      const mfa = `${text('signin.error.mfa_required')} ${text('signin.remedy.mfa_required')}`;
      expect(mfa, locale).toContain('AUTH_REQUIRE_MFA');
      expect(mfa, locale).toContain('Security Defaults');
      expect(mfa, locale).toContain('Conditional Access');
      const amr = `${text('signin.error.amr_missing')} ${text('signin.remedy.amr_missing')}`;
      expect(amr, locale).toContain('amr');
    }
  });

  it('gives every wizard result code a message and a remedy of its own (a remedy is a next step, not the message again)', () => {
    for (const code of RESULT_CODES) {
      for (const locale of LOCALES) {
        const message = CATALOGUES[locale][`setup.result.${code}`] ?? '';
        const remedy = CATALOGUES[locale][`setup.remedy.${code}`] ?? '';
        expect(remedy, `${locale}: ${code}`).not.toBe(message);
        expect(remedy.length, `${locale}: ${code}`).toBeGreaterThan(20);
      }
    }
  });

  it('never prints an AADSTS number from a message: a number is a parameter of setup.aadstsNumber only', () => {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(CATALOGUES[locale])) {
        if (key === 'setup.aadstsNumber') continue;
        expect(message, `${locale}: ${key}`).not.toMatch(/AADSTS\d/);
      }
    }
    for (const locale of LOCALES) {
      expect(placeholdersOf(CATALOGUES[locale]['setup.aadstsNumber'] ?? '')).toEqual(['number']);
    }
  });

  it('declares the parameters of the rollback hints and of the log lines, and no others', () => {
    for (const key of ROLLBACK_HINT_KEYS) {
      for (const locale of LOCALES) {
        expect(
          [...placeholdersOf(CATALOGUES[locale][key] ?? '')].sort(),
          `${locale}: ${key}`,
        ).toEqual([...(HINT_PARAMS[key] ?? [])].sort());
      }
    }
    for (const [key, names] of Object.entries(LOG_KEYS)) {
      for (const locale of LOCALES) {
        const used = placeholdersOf(CATALOGUES[locale][key] ?? '');
        for (const name of used) expect(names, `${locale}: ${key} uses {${name}}`).toContain(name);
      }
    }
  });

  it('keeps each log key a line the reader can understand without its parameters being absent: every declared parameter appears in the message, except the ones a line may do without', () => {
    // A parameter the message never prints is a value the server computed for nothing. `step` of
    // `sub_started` and `seconds` of `bootstrap_waiting` are printed too; the exceptions are none.
    for (const [key, names] of Object.entries(LOG_KEYS)) {
      for (const locale of LOCALES) {
        const used = placeholdersOf(CATALOGUES[locale][key] ?? '');
        for (const name of names)
          expect(used, `${locale}: ${key} does not print {${name}}`).toContain(name);
      }
    }
  });
});

describe('the other direction: a registry-owned namespace holds no message without a registry entry', () => {
  const required = requiredMessages();
  const keys = new Set(required.map((entry) => entry.key));

  /** Prefixes whose keys are all produced by a registry (the template role is the one extra, `role.board`). */
  const OWNED_PREFIXES = [
    'signin.error.',
    'signin.remedy.',
    'noaccess.reason.',
    'noaccess.remedy.',
    'setup.result.',
    'setup.remedy.',
    'setup.log.',
    'setup.sub.',
    'setup.step.',
    'setup.status.',
    'setup.runStatus.',
    'setup.kind.',
    'setup.hint.',
    'setup.checkOk.',
    'setup.check.',
    'setup.deviceState.',
    'connection.proof.',
    'connection.proofStatus.',
    'connection.certificate.level.',
    'connection.secrets.',
    'role.',
    'permission.',
    'qualifier.',
    'resource.',
    'origin.',
    'scope.',
    'session.',
  ];
  const EXTRA = new Set(['role.board']);

  it('has no leftover message in a namespace that a registry owns', () => {
    for (const locale of LOCALES) {
      for (const key of Object.keys(CATALOGUES[locale])) {
        if (!OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        if (EXTRA.has(key)) continue;
        expect(
          keys.has(key),
          `${locale}: "${key}" is in a registry namespace but no registry names it`,
        ).toBe(true);
      }
    }
  });

  it('keeps the lazy namespaces apart from the entry catalogue (nothing of the wizard in the entry file)', () => {
    const entry: Messages = JSON.parse(
      readFileSync(join(localesDirectory, 'en.json'), 'utf8'),
    ) as Messages;
    for (const key of Object.keys(entry)) {
      for (const namespace of LAZY_NAMESPACES)
        expect(key.startsWith(`${namespace}.`), key).toBe(false);
    }
  });
});

describe('negative fixtures: each rule fails on purpose', () => {
  interface Input {
    readonly required: readonly Required[];
    readonly catalogues: Catalogues;
  }
  const guard = ({ required, catalogues }: Input): void => {
    assertMessageKeys(required, catalogues);
  };
  const one = (extra: Partial<Required> = {}): Required[] => [
    { key: 'x.title', source: 'a registry', ...extra },
  ];
  const set = (en: Messages, nl: Messages): Catalogues => ({ en, nl });
  const options = (reason: string) => ({ name: 'message-keys', reason });

  it('a registry key without a message fails, in either language', () => {
    expectGuardFails(
      guard,
      { required: one(), catalogues: set({}, { 'x.title': 'Titel' }) },
      options('en: no message for "x.title" (a registry)'),
    );
    expectGuardFails(
      guard,
      { required: one(), catalogues: set({ 'x.title': 'Title' }, {}) },
      options('nl: no message for "x.title" (a registry)'),
    );
    expectGuardFails(
      guard,
      { required: one(), catalogues: set({ 'x.title': 'Title' }, { 'x.title': '  ' }) },
      options('nl: no message for "x.title"'),
    );
  });

  it('a new registry entry without text fails the real walk', () => {
    const withNew: Required[] = [
      ...requiredMessages(),
      { key: 'setup.result.brand_new_code', source: 'result code brand_new_code' },
    ];
    expectGuardFails(
      guard,
      { required: withNew, catalogues: CATALOGUES },
      options('en: no message for "setup.result.brand_new_code" (result code brand_new_code)'),
    );
  });

  it('placeholders that differ between the languages fail', () => {
    expectGuardFails(
      guard,
      {
        required: one(),
        catalogues: set({ 'x.title': 'Hello {name}' }, { 'x.title': 'Hallo {naam}' }),
      },
      options('"x.title" uses different placeholders in en ({name}) and nl ({naam})'),
    );
  });

  it('a log line that uses a parameter its key does not declare fails', () => {
    expectGuardFails(
      guard,
      {
        required: one({ allowedParams: ['step'] }),
        catalogues: set(
          { 'x.title': 'Step {step} {secret}' },
          { 'x.title': 'Stap {step} {secret}' },
        ),
      },
      options('"x.title" uses {secret}, which the key does not declare'),
    );
  });

  it('a rollback hint that names other parameters than the wizard fills in fails', () => {
    expectGuardFails(
      guard,
      {
        required: one({ exactParams: ['name', 'objectId'] }),
        catalogues: set({ 'x.title': 'Delete {name}' }, { 'x.title': 'Verwijder {name}' }),
      },
      options('"x.title" must use exactly {name, objectId}'),
    );
  });
});
