import { useTranslator } from '../../lib/locale';

export interface SkipLinkProps {
  /** The id of the element that holds the page (the `main` landmark). */
  readonly targetId: string;
}

/**
 * The first stop in the tab order: it is invisible until it has the focus, and it moves the focus to the
 * page content so a keyboard user does not tab through the whole menu on every page (WCAG 2.4.1). The
 * click is handled here, not left to the browser's fragment navigation, which the router would
 * otherwise see as a change of address.
 */
export function SkipLink({ targetId }: SkipLinkProps) {
  const { t } = useTranslator();
  return (
    <a
      href={`#${targetId}`}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(targetId)?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-toast focus:rounded-md focus:border focus:border-line-control focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-body focus:font-medium focus:text-fg focus:shadow-2"
    >
      {t('a11y.skipToContent')}
    </a>
  );
}
