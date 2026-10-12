// T-B-079, FR-B-217 (extraction), TB-07 (+ negative): the AADSTS number of a token-endpoint answer.
//
// Learn names the codes (`AADSTS65001`, `AADSTS90093`, `AADSTS90094`, `AADSTS50105`, `AADSTS53003`,
// `AADSTS530036`, `AADSTS700027`; see the table in packages/shared/src/auth/aadsts-map.ts). Only the
// leading number of `error_description` is read, by the strict pattern of the shared map; the free
// text is dropped, whatever it says (an attacker or a tenant admin can influence some of it).
import { describe, expect, it } from 'vitest';
import { tokenErrorOf } from '../../../src/integrations/identity/aadsts.js';
import { HOSTILE_DESCRIPTION } from '../../fakes/fake-tenant/entra/index.js';

describe('the number and the error string of an answer', () => {
  it.each([
    [
      {
        error: 'invalid_client',
        error_description:
          'AADSTS700027: Client assertion contains an invalid signature.\r\nTrace ID: x',
      },
      'invalid_client',
      700027,
    ],
    [
      { error: 'invalid_grant', error_description: 'AADSTS70000: bad code' },
      'invalid_grant',
      70000,
    ],
    [{ error: 'access_denied', error_description: 'AADSTS53003: blocked' }, 'access_denied', 53003],
    [
      { error: 'consent_required', error_description: 'AADSTS65001: no consent' },
      'consent_required',
      65001,
    ],
    [
      { error: 'interaction_required', error_description: 'AADSTS530036: flow' },
      'interaction_required',
      530036,
    ],
    [{ error: 'temporarily_unavailable' }, 'temporarily_unavailable', undefined],
  ])('%j', (body, error, aadsts) => {
    expect(tokenErrorOf(body)).toEqual({ error, ...(aadsts === undefined ? {} : { aadsts }) });
  });

  it('drops the free text, also when it is hostile or carries other numbers', () => {
    const read = tokenErrorOf({
      error: 'invalid_request',
      error_description: `AADSTS70011: ${HOSTILE_DESCRIPTION} AADSTS65001 AADSTS99999`,
    });
    expect(read).toEqual({ error: 'invalid_request', aadsts: 70011 });
    expect(JSON.stringify(read)).not.toContain('script');
  });

  it.each([
    'see AADSTS65001 in the middle',
    ' AADSTS65001: leading space',
    'aadsts65001: lower case',
    'AADSTS: no digits',
    'AADSTS123: three digits',
    'AADSTS12345678: eight digits',
  ])(
    'reads no number from %j (+ negative: only the strict leading pattern counts)',
    (description) => {
      const read = tokenErrorOf({ error: 'invalid_request', error_description: description });
      expect(read.aadsts).toBeUndefined();
    },
  );

  it.each([
    [{ error: 'Not A Word' }],
    [{ error: 5 }],
    [{ error: 'x'.repeat(100) }],
    [{}],
    [null],
    ['text'],
    [[]],
  ])('an error that is not an OAuth error string is "unknown": %j', (body) => {
    expect(tokenErrorOf(body).error).toBe('unknown');
  });
});
