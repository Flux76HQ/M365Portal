// Search parameters that arrive from outside (T-B-297). The router parses a value as JSON when it can,
// so `?signedout=1` is the number 1 and `?ref=12345678` a number; the pages that read text from the
// address ask for the text. Only a string or a finite number counts; anything else (an array from a
// repeated parameter, an object) is no value at all.
export function stringSearchParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
