// The live catalogues of the application: the entry files, `locales/{en,nl}.json`, copied once, plus
// whatever lazy namespaces were loaded since (`load-namespace.ts`). `createTranslator` reads these
// objects at every lookup, so a translator made before a namespace was loaded finds its messages as
// soon as they arrive. Nothing here is a message source of its own: the entry catalogues travel in the
// entry chunk (PD-16) and the lazy ones are separate files.
import en from './locales/en.json' with { type: 'json' };
import nl from './locales/nl.json' with { type: 'json' };
import type { Catalogue, Locale } from './types.js';

/** One mutable catalogue per locale. Only `load-namespace.ts` adds to them, and only a whole namespace at a time. */
export const LIVE_CATALOGUES: Readonly<Record<Locale, Record<string, string>>> = {
  en: { ...en },
  nl: { ...nl },
};

/** The same catalogues as the read-only view a translator takes. */
export function liveCatalogueSet(): { readonly en: Catalogue; readonly nl: Catalogue } {
  return LIVE_CATALOGUES;
}
