import { DEFAULT_PORT } from '@m365portal/shared/limits';
import { describe, expect, it } from 'vitest';
import { readListenOptions } from '../src/listen.js';

describe('readListenOptions', () => {
  it('defaults to 0.0.0.0 and the default port of the shared limits (8080)', () => {
    expect(DEFAULT_PORT).toBe(8080);
    expect(readListenOptions({})).toEqual({ port: DEFAULT_PORT, hostname: '0.0.0.0' });
    expect(readListenOptions({ HOST: '' })).toEqual({ port: DEFAULT_PORT, hostname: '0.0.0.0' });
  });

  it('reads PORT and HOST', () => {
    expect(readListenOptions({ PORT: '4173', HOST: '127.0.0.1' })).toEqual({
      port: 4173,
      hostname: '127.0.0.1',
    });
  });

  it.each(['1024', '8080', '18080', '65535'])(
    'accepts PORT=%s (FR-A-016: 1024 to 65535)',
    (value) => {
      expect(readListenOptions({ PORT: value }).port).toBe(Number(value));
    },
  );

  // FR-A-016: the container runs unprivileged with all capabilities dropped, so a port below 1024
  // is a configuration error, and so are 0 (a random port), an empty value and non-numeric input.
  it.each([
    '0',
    '80',
    '443',
    '1023',
    '65536',
    '100000',
    '',
    'abc',
    '-1',
    '80.5',
    '0x1F90',
    '1e4',
    ' 8080',
    '8080 ',
    '08080',
    '+8080',
  ])('rejects PORT=%j with a message that names PORT and does not echo the value', (value) => {
    expect(() => readListenOptions({ PORT: value })).toThrow(
      /^PORT must be an integer between 1024 and 65535$/,
    );
  });

  it('treats an unset PORT as the default, but an empty one as an error', () => {
    expect(readListenOptions({ PORT: undefined }).port).toBe(DEFAULT_PORT);
    expect(() => readListenOptions({ PORT: '' })).toThrow('PORT');
  });
});
