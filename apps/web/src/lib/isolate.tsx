// Isolating user-controlled text inside a translated sentence (E-07, defect D-3).
//
// An organisation name is data. When it is Arabic or Hebrew and is interpolated into "Appearance of
// {name}" as plain text, the Unicode bidi algorithm lets the right-to-left run pull the neighbouring
// neutral characters (spaces, colons, full stops) into its own direction and the sentence reads out
// of order. A `<bdi>` element isolates the run (it is `unicode-bidi: isolate` with `dir=auto`).
//
// `t()` returns a string, and a string cannot hold an element, so the value is swapped for a private
// marker while the sentence is built and replaced by `<bdi>{value}</bdi>` afterwards. The markers are
// Unicode private-use characters; a user value never goes through the catalogue's interpolation, so
// it cannot forge one.
import type { ReactNode } from 'react';
import type { MessageKey, MessageParams } from '@m365portal/shared/i18n';

type Translate = (key: MessageKey, params?: MessageParams) => string;

const OPEN = '';
const CLOSE = '';
const MARKER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

/**
 * `t(key, { ...params, ...isolated })` as nodes, where every entry of `isolated` is written inside a
 * `<bdi>`. Use it wherever text a person typed (an organisation name, a display name) becomes part of
 * a sentence that is shown as text. For an attribute (a string is required) use `aria-labelledby`
 * on an element built with this function instead.
 */
export function isolatedMessage(
  t: Translate,
  key: MessageKey,
  params: MessageParams | undefined,
  isolated: Readonly<Record<string, string>>,
): ReactNode {
  const names = Object.keys(isolated);
  const markers = Object.fromEntries(names.map((name, index) => [name, `${OPEN}${index}${CLOSE}`]));
  const sentence = t(key, { ...params, ...markers });
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of sentence.matchAll(MARKER)) {
    parts.push(sentence.slice(last, match.index));
    const value = isolated[names[Number(match[1])] ?? ''] ?? '';
    parts.push(<bdi key={match.index}>{value}</bdi>);
    last = match.index + match[0].length;
  }
  parts.push(sentence.slice(last));
  return <>{parts}</>;
}
