// T-B-183 (part): the identity key is a canonical, lower-case (tid, oid) pair.
import { describe, expect, it } from 'vitest';
import { identityKey } from '../../src/auth/principal.js';

describe('server/auth/principal: identityKey', () => {
  it('is the lower-case tid and oid, in that order', () => {
    expect(
      identityKey('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'),
    ).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('keeps the empty oid of a break-glass principal distinct', () => {
    expect(identityKey('11111111-1111-4111-8111-111111111111', '')).toBe(
      '11111111-1111-4111-8111-111111111111/',
    );
  });
});
