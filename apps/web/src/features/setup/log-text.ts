// The text of a log line (T-B-300; FR-B-211, FR-B-603): the server sends a catalogue key and scalar
// parameters, never a sentence. A parameter that names a step, a sub-action, an object kind, a run status
// or a result code is translated too, so "step: configure" reads as a word the person knows. Everything
// else (a name the panel chose, a counter, the first characters of a thumbprint) is printed as it is.
import type { MessageKey, MessageParams, Translator } from '@m365portal/shared/i18n';
import { RUN_STATUSES } from '@m365portal/shared/schemas/connection';
import { isResultCode } from '@m365portal/shared/setup/result-codes';
import { STEP_KEYS, SUB_ACTION_KEYS } from '@m365portal/shared/setup/steps';

const KINDS = ['app_role_assignment', 'application', 'certificate', 'directory_role_assignment', 'service_principal'];

function word(t: Translator['t'], name: string, value: string): string {
  const has = (list: readonly string[]): boolean => list.includes(value);
  switch (name) {
    case 'step':
      return has(STEP_KEYS) ? t(`setup.step.${value}` as MessageKey) : value;
    case 'sub':
      return has(SUB_ACTION_KEYS) ? t(`setup.sub.${value}` as MessageKey) : value;
    case 'kind':
      return has(KINDS) ? t(`setup.kind.${value}` as MessageKey) : value;
    case 'status':
      return has(RUN_STATUSES) ? t(`setup.runStatus.${value}` as MessageKey) : value;
    case 'mode':
      return value === 'continue' || value === 'reconcile' ? t(`setup.runMode.${value}`) : value;
    case 'steps':
      return value
        .split(',')
        .map((part) => word(t, 'step', part.trim()))
        .join(', ');
    case 'code':
      return isResultCode(value) ? t(`setup.result.${value}` as MessageKey) : value;
    default:
      return value;
  }
}

/** The line as a sentence in the language of `translator`. An unknown key reads as the key itself. */
export function logLineText(translator: Translator, key: string, params: Readonly<Record<string, string | number | boolean>>): string {
  const { t } = translator;
  const text: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    text[name] = typeof value === 'string' ? word(t, name, value) : typeof value === 'boolean' ? String(value) : value;
  }
  return t(key as MessageKey, text as MessageParams);
}
