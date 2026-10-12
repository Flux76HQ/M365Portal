// The rollback hints and the result messages of the wizard (T-B-302; plan 9.13; FR-B-603).
//
// A hint arrives as a catalogue key and a few parameters taken from the step's detail (`name`, `objectId`,
// `appId`, `thumbprint8`, `kind`, `count`, `host`). The messages ask for the words a person reads
// (`thumbprint`, `appObjectId`, `roles`, `role`), so this module maps one to the other and fills what the
// server does not send from what the page knows. A parameter nobody can fill reads as a dash, never as a
// placeholder in curly braces.
import { errorDetailMessageKey } from '@m365portal/shared/i18n/detail-codes';
import type { MessageKey, Translator } from '@m365portal/shared/i18n';
import {
  EXCHANGE_APP_ROLES,
  GRAPH_APP_ROLES,
  isExchangeRoleKey,
} from '@m365portal/shared/setup/graph-roles';
import { isResultCode } from '@m365portal/shared/setup/result-codes';
import { ApiError } from '../../lib/api';
import { messageForError } from '../../lib/problem';
import { ROLLBACK_HINT_KEYS, type RollbackHintKey } from '@m365portal/shared/setup/steps';

type Scalar = string | number | boolean;
const DASH = '-';

const text = (value: Scalar | undefined): string => (value === undefined ? DASH : String(value));

export function isRollbackHintKey(key: string): key is RollbackHintKey {
  return (ROLLBACK_HINT_KEYS as readonly string[]).includes(key);
}

export interface HintContext {
  /** The object id of the application, when the page knows it (the certificate hint names it). */
  readonly applicationObjectId?: string | null;
  /** The sub-action the hint belongs to: the grants hint lists the roles of its resource. */
  readonly subAction?: string;
}

/** The sentence of a rollback hint, or null for a key that is not a hint of the registry. */
export function hintText(
  translator: Translator,
  hint: { readonly key: string; readonly params: Readonly<Record<string, Scalar>> },
  context: HintContext = {},
): string | null {
  if (!isRollbackHintKey(hint.key)) return null;
  const { t } = translator;
  const p = hint.params;
  switch (hint.key) {
    case 'setup.hint.application':
      return t(hint.key, { name: text(p.name), objectId: text(p.objectId), appId: text(p.appId) });
    case 'setup.hint.service_principal':
      return t(hint.key, { objectId: text(p.objectId) });
    case 'setup.hint.certificate':
      return t(hint.key, {
        thumbprint: text(p.thumbprint ?? p.thumbprint8),
        appObjectId: text(p.appObjectId ?? p.objectId ?? context.applicationObjectId ?? undefined),
      });
    case 'setup.hint.grants': {
      const named = p.roles;
      const roles =
        named !== undefined
          ? String(named)
          : context.subAction === 'exchange_permissions'
            ? Object.values(EXCHANGE_APP_ROLES).join(', ')
            : GRAPH_APP_ROLES.join(', ');
      return t(hint.key, { roles });
    }
    case 'setup.hint.exchange_role': {
      const raw = p.role ?? p.name;
      const role =
        typeof raw === 'string' && isExchangeRoleKey(raw)
          ? t(`setup.exchangeRole.${raw}` as MessageKey)
          : text(raw);
      return t(hint.key, { role });
    }
    case 'setup.hint.bootstrap_consent':
      return t(hint.key);
  }
}

export interface ResultText {
  readonly message: string;
  readonly remedy: string;
}

/**
 * The message and the remedy of a result code. A code this bundle does not know (a newer server) reads as
 * a generic message with the number in it and a generic remedy, never as a raw key.
 */
export function resultText(translator: Translator, code: string): ResultText {
  const { t } = translator;
  if (isResultCode(code)) {
    return {
      message: t(`setup.result.${code}` as MessageKey),
      remedy: t(`setup.remedy.${code}` as MessageKey),
    };
  }
  return { message: t('setup.unknownResult', { code }), remedy: t('setup.unknownRemedy') };
}

/**
 * The message for an error of a request: when the problem carries an `errors[]` detail code that has a
 * message of its own (`owner_changed`, `principal_disabled`, `privileged_role_group`), that message; otherwise
 * the message of the problem code. Never the server's text.
 */
export function errorText(
  translator: Translator,
  error: unknown,
  publicOrigin: string | null,
): string {
  if (error instanceof ApiError) {
    for (const detail of error.errors) {
      const key = errorDetailMessageKey(detail.code);
      if (key !== undefined) return translator.t(key as MessageKey);
    }
  }
  return messageForError(translator, error, { publicOrigin });
}
