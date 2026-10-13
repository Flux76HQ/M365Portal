// Small renderers shared by the users and groups pages: a missing value is a dash that a screen reader
// reads as "not available" (EC-C10), and a timestamp is shown in the language of the page.
import type { Translator } from '@m365portal/shared/i18n';
import { CircleCheckIcon, CircleXIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A value Graph did not return: a dash for the eye, the words for assistive technology. */
export function Missing({ translator }: { readonly translator: Pick<Translator, 't'> }) {
  return (
    <>
      <span aria-hidden="true">-</span>
      <span className="sr-only">{translator.t('users.value.unknown')}</span>
    </>
  );
}

/** Text, or the dash when there is none. Text is data: it is rendered as a text node, never as markup. */
export function textOrDash(translator: Pick<Translator, 't'>, value: string | null): ReactNode {
  return value === null || value === '' ? <Missing translator={translator} /> : value;
}

/** Yes, no or the dash. */
export function yesNo(translator: Pick<Translator, 't'>, value: boolean | null): ReactNode {
  if (value === null) return <Missing translator={translator} />;
  return translator.t(value ? 'users.value.yes' : 'users.value.no');
}

/** Enabled or disabled, with an icon and the word (never colour alone). */
export function StateMark({
  translator,
  enabled,
}: {
  readonly translator: Pick<Translator, 't'>;
  readonly enabled: boolean | null;
}) {
  if (enabled === null) return <Missing translator={translator} />;
  const Icon = enabled ? CircleCheckIcon : CircleXIcon;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon
        aria-hidden="true"
        className={enabled ? 'size-4 shrink-0 text-success' : 'size-4 shrink-0 text-fg-muted'}
      />
      {translator.t(enabled ? 'users.state.enabled' : 'users.state.disabled')}
    </span>
  );
}

/** A UTC timestamp of the wire as a date and time in the language of the page. */
export function formatTimestamp(
  translator: Pick<Translator, 'd'>,
  value: string | null,
): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : translator.d(time, { dateStyle: 'long', timeStyle: 'short' });
}
