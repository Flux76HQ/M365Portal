// Reading the application key at start (plan 6.1 step 6, 6.4): from the variable, or from the file
// the variable `APP_KEY_FILE` names. This happens at start and not while the configuration is
// parsed, so that an unreadable file is the degraded state `key_missing` and not an exit.
//
// Nothing here logs. The result is a key, or the reason there is none, as a code.
import { closeSync, openSync, readSync } from 'node:fs';
import type { KeySource } from '../config/env.js';
import {
  APP_KEY_FILE_MAX_BYTES,
  parseAppKey,
  parseAppKeyFileContent,
  type AppKeyFailure,
} from './app-key.js';
import { wipe } from './sealed-box.js';

export type LoadedKey =
  | { readonly status: 'absent' }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: AppKeyFailure }
  | { readonly status: 'loaded'; readonly key: Uint8Array };

/** Up to the limit plus one byte of the file, so a file that is too large is noticed, not loaded. */
function readFileCapped(path: string): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(APP_KEY_FILE_MAX_BYTES + 1);
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/** `absent`: nothing configured. `missing`: configured but unreadable. */
export function loadKey(source: KeySource): LoadedKey {
  if (source.source === 'none') return { status: 'absent' };
  if (source.source === 'env') {
    const parsed = parseAppKey(source.value.reveal());
    return parsed.ok
      ? { status: 'loaded', key: parsed.key }
      : { status: 'invalid', reason: parsed.reason };
  }
  const content = readFileCapped(source.path);
  if (content === undefined) return { status: 'missing' };
  try {
    const parsed = parseAppKeyFileContent(content);
    return parsed.ok
      ? { status: 'loaded', key: parsed.key }
      : { status: 'invalid', reason: parsed.reason };
  } finally {
    wipe(content);
  }
}
