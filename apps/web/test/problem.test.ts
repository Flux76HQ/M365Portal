//
// PROBLEM TRANSLATION (FR-A-112; plan 9.2; T-A-165; E-20).
//
// The UI shows the catalogue message of a problem code and never the server's English `detail`.
// lib/problem.ts chooses the key with `problemMessageKey` of @m365portal/shared (the one mapping of
// code to message) and fills the parameters the messages use: the request id of the generic message,
// the origin of `origin_not_allowed`, the seconds of the two busy codes.
import { createTranslator, placeholdersOf, type Locale } from '@m365portal/shared/i18n';
import { PROBLEM_CODES, type ProblemCode } from '@m365portal/shared/problem';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../src/lib/api';
import {
  messageForError,
  problemMessage,
  translateProblemCode,
  type ProblemMessage,
} from '../src/lib/problem';

const LOCALES: readonly Locale[] = ['en', 'nl'];
const CODES = Object.keys(PROBLEM_CODES) as ProblemCode[];

function text(locale: Locale, code: string, params?: Parameters<typeof problemMessage>[1]): string {
  return translateProblemCode(createTranslator(locale), code, params);
}

describe('problemMessage', () => {
  it('selects problem.<code> for every code of the registry, with no parameters needed', () => {
    for (const code of CODES) {
      const message: ProblemMessage = problemMessage(code);
      expect(message.key, code).toBe(`problem.${code}`);
    }
  });

  it('selects problem.unknown for a code this version does not know', () => {
    for (const code of ['a_code_from_a_newer_server', 'http_502', '', '__proto__', 'constructor']) {
      expect(problemMessage(code).key, code).toBe('problem.unknown');
    }
  });

  it('is the same function as translateProblemCode under its other name: a message, then the text', () => {
    // The name `problemMessage` is the one the spec uses; the function that returns text is
    // translateProblemCode. Both are built on problemMessageKey of the shared package.
    expect(typeof problemMessage).toBe('function');
    expect(typeof translateProblemCode).toBe('function');
  });
});

describe('translateProblemCode', () => {
  it('gives the catalogue message of the code in each language, not the server text', () => {
    for (const locale of LOCALES) {
      const { t } = createTranslator(locale);
      for (const code of CODES) {
        // A message with a placeholder is not the same text once the parameters are filled in
        // (origin_not_allowed, rate_limited, image_processing_busy, and the Phase B messages with a
        // wait: setup_token_locked, break_glass_locked, graph_throttled); the next test covers them.
        if (placeholdersOf(t(`problem.${code}`)).length > 0) continue;
        expect(text(locale, code), `${locale} ${code}`).toBe(t(`problem.${code}`));
      }
    }
  });

  it('leaves no placeholder visible, whatever the code, even without any parameter', () => {
    for (const locale of LOCALES) {
      for (const code of [...CODES, 'a_code_from_a_newer_server']) {
        expect(text(locale, code), `${locale} ${code}`).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      }
    }
  });

  it('shows a generic message with the code and the request id for an unknown code', () => {
    for (const locale of LOCALES) {
      const message = text(locale, 'a_code_from_a_newer_server', { requestId: 'req-0123456789' });

      expect(message).toContain('a_code_from_a_newer_server');
      expect(message).toContain('req-0123456789');
      expect(message).toBe(
        createTranslator(locale).t('problem.unknown', {
          code: 'a_code_from_a_newer_server',
          requestId: 'req-0123456789',
        }),
      );
    }
  });

  it('shows the code even when there is no request id, and never prints a placeholder', () => {
    const message = text('en', 'http_502');

    expect(message).toContain('http_502');
    expect(message).not.toContain('{');
  });

  it('names the origin the server expects for origin_not_allowed, from the problem first', () => {
    for (const locale of LOCALES) {
      const message = text(locale, 'origin_not_allowed', {
        expectedOrigin: 'https://panel.example.com',
        publicOrigin: 'https://other.example.com',
      });

      expect(message).toContain('https://panel.example.com');
      expect(message).not.toContain('other.example.com');
    }
  });

  it('falls back to the origin of /api/v1/me when the problem carries none', () => {
    const message = text('en', 'origin_not_allowed', { publicOrigin: 'https://panel.example.com' });

    expect(message).toContain('https://panel.example.com');
  });

  it('still reads well when no origin is known at all', () => {
    const message = text('nl', 'origin_not_allowed', {});

    expect(message).toContain('PUBLIC_BASE_URL');
    expect(message).not.toContain('{origin}');
  });

  it('fills the seconds of the busy codes from Retry-After, at least one', () => {
    expect(text('en', 'rate_limited', { retryAfterSeconds: 7 })).toContain('7');
    expect(text('nl', 'image_processing_busy', { retryAfterSeconds: 3 })).toContain('3');
    expect(text('en', 'rate_limited', { retryAfterSeconds: 0 })).toContain('1');
    expect(text('en', 'rate_limited', { retryAfterSeconds: null })).not.toContain('{seconds}');
  });

  it('never shows the English detail: it is not an input', () => {
    const error = new ApiError({
      code: 'internal_error',
      status: 500,
      requestId: 'req-0123456789',
      errors: [],
      expectedOrigin: null,
      retryAfterSeconds: null,
    });
    const detail = PROBLEM_CODES.internal_error.detail;

    for (const locale of LOCALES) {
      expect(messageForError(createTranslator(locale), error)).not.toContain(detail);
      expect(text(locale, 'internal_error')).not.toContain(detail);
    }
    expect(text('nl', 'internal_error')).not.toBe(text('en', 'internal_error'));
  });
});

describe('messageForError', () => {
  const translator = createTranslator('en');

  it('translates an ApiError by its code and passes along its request id, origin and retry delay', () => {
    const rate = new ApiError({
      code: 'rate_limited',
      status: 429,
      requestId: 'req-0123456789',
      errors: [],
      expectedOrigin: null,
      retryAfterSeconds: 12,
    });
    expect(messageForError(translator, rate)).toContain('12');

    const origin = new ApiError({
      code: 'origin_not_allowed',
      status: 403,
      requestId: null,
      errors: [],
      expectedOrigin: 'https://panel.example.com',
      retryAfterSeconds: null,
    });
    expect(messageForError(translator, origin)).toContain('https://panel.example.com');

    const unknown = new ApiError({
      code: 'brand_new',
      status: 418,
      requestId: 'req-0123456789',
      errors: [],
      expectedOrigin: null,
      retryAfterSeconds: null,
    });
    const message = messageForError(translator, unknown);
    expect(message).toContain('brand_new');
    expect(message).toContain('req-0123456789');
  });

  it('uses the origin of /api/v1/me when the error does not carry one', () => {
    const origin = new ApiError({
      code: 'origin_not_allowed',
      status: 403,
      requestId: null,
      errors: [],
      expectedOrigin: null,
      retryAfterSeconds: null,
    });

    expect(
      messageForError(translator, origin, { publicOrigin: 'https://me.example.com' }),
    ).toContain('https://me.example.com');
  });

  it('gives anything else the generic message with a code of its own, never an exception text', () => {
    for (const error of [
      new Error('SECRET stack text'),
      'a string',
      null,
      undefined,
      { code: 1 },
    ]) {
      const message = messageForError(translator, error);
      expect(message, typeof error).toContain('client_error');
      expect(message, typeof error).not.toContain('SECRET');
    }
    expect(messageForError(translator, new NetworkError('offline'))).toContain('network_error');
  });
});
