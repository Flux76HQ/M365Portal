// @m365portal/shared is consumed as TypeScript source (see "exports" in package.json) by Vite,
// Vitest, tsx and esbuild, so there is no build step. Because the server type-checks this source
// under NodeNext, any relative import added here needs a `.js` extension.
//
// This file is a placeholder. The real domain contracts (Zod schemas, error codes, permission
// catalogue) are added by the streams that own them.

/** The fixed product name. Not the organisation name, which is configured at runtime. */
export const PRODUCT_NAME = 'M365Portal';

declare const brandTag: unique symbol;

/** A nominal type: a `T` that has been checked, so it cannot be mixed up with a plain `T`. */
export type Brand<T, Name extends string> = T & { readonly [brandTag]: Name };

/**
 * Mark an already validated value as a branded type. The caller owns the validation:
 * this function only changes the type, never the value.
 */
export function brand<T, Name extends string>(value: T): Brand<T, Name> {
  return value as Brand<T, Name>;
}
