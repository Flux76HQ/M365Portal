import { describe, expect, it } from 'vitest';
import { readListenOptions } from './listen.js';

describe('readListenOptions', () => {
  it('defaults to 0.0.0.0:8080', () => {
    expect(readListenOptions({})).toEqual({ port: 8080, hostname: '0.0.0.0' });
    expect(readListenOptions({ PORT: '', HOST: '' })).toEqual({ port: 8080, hostname: '0.0.0.0' });
  });

  it('reads PORT and HOST', () => {
    expect(readListenOptions({ PORT: '4173', HOST: '127.0.0.1' })).toEqual({
      port: 4173,
      hostname: '127.0.0.1',
    });
    expect(readListenOptions({ PORT: '0' }).port).toBe(0);
  });

  it.each(['abc', '-1', '65536', '100000', '80.5', '0x50', '1e3', ' 80'])(
    'rejects PORT=%j with a message that does not echo the value',
    (value) => {
      expect(() => readListenOptions({ PORT: value })).toThrow(
        /^PORT must be an integer between 0 and 65535$/,
      );
    },
  );
});
