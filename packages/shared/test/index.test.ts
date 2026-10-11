import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, brand, type Brand } from '../src/index.js';

describe('@m365portal/shared placeholder', () => {
  it('brand() returns the same runtime value with a nominal type', () => {
    const port: Brand<number, 'Port'> = brand(9300);
    expect(port).toBe(9300);
    expect(port + 1).toBe(9301);
  });

  it('exposes the fixed product name', () => {
    expect(PRODUCT_NAME).toBe('M365Portal');
  });
});
