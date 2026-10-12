// The English and Dutch catalogues the Appearance tests read: the entry files plus the lazy files of the
// Appearance namespaces (T-B-307 moved them out of the entry; the route loader fetches them in the application).
import en from '@m365portal/shared/i18n/locales/en.json';
import nl from '@m365portal/shared/i18n/locales/nl.json';
import enAppearance from '@m365portal/shared/i18n/locales/lazy/appearance.en.json';
import enLogo from '@m365portal/shared/i18n/locales/lazy/logo.en.json';
import enAccent from '@m365portal/shared/i18n/locales/lazy/accent.en.json';
import enPreview from '@m365portal/shared/i18n/locales/lazy/preview.en.json';
import nlAppearance from '@m365portal/shared/i18n/locales/lazy/appearance.nl.json';
import nlLogo from '@m365portal/shared/i18n/locales/lazy/logo.nl.json';
import nlAccent from '@m365portal/shared/i18n/locales/lazy/accent.nl.json';
import nlPreview from '@m365portal/shared/i18n/locales/lazy/preview.nl.json';

export const enCatalogue: Readonly<Record<string, string>> = { ...en, ...enAppearance, ...enLogo, ...enAccent, ...enPreview };

export const nlCatalogue: Readonly<Record<string, string>> = { ...nl, ...nlAppearance, ...nlLogo, ...nlAccent, ...nlPreview };
