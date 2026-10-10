import { describe, expect, it } from 'vitest';
import { APP_VERSION, parseVersion } from '../src/version.js';

describe('version', () => {
  it('APP_VERSION is MAJOR.MINOR.PATCH', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('parseVersion trims a trailing newline', () => {
    expect(parseVersion('1.2.3\n')).toBe('1.2.3');
  });

  it.each(['', '1.2', 'v1.2.3', '1.2.3-rc.1', 'latest'])('parseVersion rejects "%s"', (value) => {
    expect(() => parseVersion(value)).toThrow('VERSION must contain MAJOR.MINOR.PATCH');
  });
});
