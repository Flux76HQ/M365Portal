import type { AccentTokenSet } from '@m365portal/shared/branding/accent';
import { useId, useMemo, useState } from 'react';
import { OrgMarkView } from '../../components/shell/OrgMark';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { isolatedMessage } from '../../lib/isolate';
import { useTranslator } from '../../lib/locale';
import { useBrandingTools, type BrandingTools } from './tools';
import type { AssetRef, LogoVariant } from './types';
import { useCssProperties } from './use-css-properties';

// The live preview (T-A-213; FR-A-132, A-39; US-2.1, US-2.2).
//
// The shell as it will look: the sidebar with the organisation mark, the header, and the primary and
// secondary buttons in rest, hover, pressed and focus, in the light and the dark theme side by side. It
// draws from its props only: typing a name or a colour changes it at once and nothing is requested.
//
// Each pane is a scope for the colour variables. The variables of its theme (surfaces, text, status and
// the derived accent) are written on the pane element through the CSSOM, so every token utility inside
// it (`bg-accent`, `text-fg`, ...) resolves to that theme's value whatever theme the page itself is in.
// The panes also carry `data-theme`, which the `dark:` variant reads. The window inside is decoration:
// hidden from assistive technology, its buttons out of the tab order; a text summary stands in for it.
//
// The mark is the shell's own `OrgMarkView` (components/shell/OrgMark.tsx), drawn for the pane's theme: the
// logo of that theme (one logo serves both themes, A-39), on a plate where `logoPlateFor` says so and
// never recoloured, else the monogram tile. The shell and the preview cannot drift apart.

export interface LivePreviewProps {
  /** The organisation name as typed. A name the rules refuse previews as the default name. */
  readonly orgName: string;
  /** The accent as typed. Text that is not a colour keeps the last colour that was. */
  readonly accent: string;
  readonly logos: Readonly<Record<LogoVariant, AssetRef | null>>;
}

type PreviewTheme = 'light' | 'dark';
const THEMES: readonly PreviewTheme[] = ['light', 'dark'];
type ButtonVariant = 'primary' | 'secondary';
const BUTTON_VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary'];
type ButtonState = 'rest' | 'hover' | 'active' | 'focus';
const BUTTON_STATES: readonly ButtonState[] = ['rest', 'hover', 'active', 'focus'];

// What a pointer or the keyboard would draw, forced so that a still image shows it (the same utilities
// the buttons use for the real thing).
const FORCED: Record<ButtonVariant, Record<ButtonState, string>> = {
  primary: {
    rest: '',
    hover: 'bg-accent-hover',
    active: 'bg-accent-active',
    focus: 'outline-2 outline-offset-2 outline-focus-ring',
  },
  secondary: {
    rest: '',
    hover: 'bg-accent-subtle',
    active: 'bg-accent-subtle',
    focus: 'outline-2 outline-offset-2 outline-focus-ring',
  },
};

/** The variables of one theme: surfaces, text and status roles, and the derived accent. */
function paneVariables(
  tools: BrandingTools,
  theme: PreviewTheme,
  accent: AccentTokenSet,
): Record<string, string> {
  const { tokens } = tools;
  // `--fg-muted` and `--line-subtle` are aliases declared once on `:root` (styles/a11y.css), so they
  // would keep the page's theme inside the pane; declared here they resolve against the pane's roles.
  const variables: Record<string, string> = {
    'color-scheme': theme,
    '--fg-muted': 'var(--text-muted)',
    '--line-subtle': 'var(--border-subtle)',
  };
  for (const [name, variable] of Object.entries(tokens.SURFACE_VARIABLES)) {
    variables[variable] = tokens.SURFACES[theme][name as keyof typeof tokens.SURFACE_VARIABLES];
  }
  for (const [name, variable] of Object.entries(tokens.NEUTRAL_VARIABLES)) {
    variables[variable] =
      tokens.NEUTRAL_ROLES[theme][name as keyof typeof tokens.NEUTRAL_VARIABLES];
  }
  for (const [field, variable] of Object.entries(tokens.ACCENT_VARIABLES)) {
    variables[variable] = accent[field as keyof typeof tokens.ACCENT_VARIABLES].toLowerCase();
  }
  return variables;
}

/** The mark of the shell for the draft: the shell's own `OrgMarkView`, drawn for this pane's theme. */
function PreviewMark({
  name,
  logos,
  theme,
  variant,
  tools,
}: {
  readonly name: string;
  readonly logos: LivePreviewProps['logos'];
  readonly theme: PreviewTheme;
  readonly variant: 'full' | 'compact';
  readonly tools: BrandingTools;
}) {
  // The monogram of the typed name, from the same shared function the server uses for the saved one.
  const tile = useMemo(() => tools.monogram.monogramFor(name), [tools, name]);
  return (
    <OrgMarkView
      branding={{ orgName: name, logos, monogram: tile }}
      theme={theme}
      variant={variant}
      showName
      className="gap-2"
    />
  );
}

function PreviewButtons({ variant }: { readonly variant: ButtonVariant }) {
  const { t } = useTranslator();
  return (
    <div className="flex flex-wrap items-start gap-3">
      {BUTTON_STATES.map((state) => (
        <div key={state} className="flex flex-col items-start gap-1">
          <Button
            variant={variant}
            size="sm"
            tabIndex={-1}
            data-preview-button={variant}
            data-state={state}
            className={FORCED[variant][state]}
          >
            {t(`preview.button.${variant}`)}
          </Button>
          <span className="text-caption text-fg-muted">{t(`preview.state.${state}`)}</span>
        </div>
      ))}
    </div>
  );
}

function PreviewPane({
  theme,
  name,
  accent,
  accentHex,
  logos,
  tools,
}: {
  readonly theme: PreviewTheme;
  readonly name: string;
  readonly accent: AccentTokenSet;
  readonly accentHex: string;
  readonly logos: LivePreviewProps['logos'];
  readonly tools: BrandingTools;
}) {
  const { t } = useTranslator();
  const variables = useMemo(() => paneVariables(tools, theme, accent), [tools, theme, accent]);
  const reference = useCssProperties<HTMLDivElement>(variables);
  const themeName = t(`preview.theme.${theme}`);
  const labelId = useId();

  return (
    <div
      ref={reference}
      role="group"
      aria-labelledby={labelId}
      data-preview-theme={theme}
      data-theme={theme}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line-subtle bg-surface-page p-3 text-fg"
    >
      {/* The name is typed text: it sits in a <bdi> in both sentences (E-07, defect D-3). An attribute
          cannot hold an element, so the group is labelled through this element. */}
      <span id={labelId} hidden>
        {isolatedMessage(t, 'preview.paneLabel', { theme: themeName }, { name })}
      </span>
      <h3 className="text-body-sm font-semibold text-fg">{themeName}</h3>
      <p className="sr-only">
        {isolatedMessage(t, 'preview.summary', { theme: themeName, accent: accentHex }, { name })}
      </p>

      <div
        aria-hidden="true"
        data-preview-window
        className="grid min-h-60 grid-cols-[7rem_minmax(0,1fr)] overflow-hidden rounded-md border border-line-subtle bg-surface-page sm:grid-cols-[10rem_minmax(0,1fr)]"
      >
        <div
          data-preview-part="sidebar"
          className="flex min-w-0 flex-col gap-3 border-e border-line-subtle bg-surface-sidebar p-2"
        >
          <PreviewMark name={name} logos={logos} theme={theme} variant="full" tools={tools} />
          <ul className="flex flex-col gap-1 text-body-sm font-medium">
            <li className="relative rounded-md bg-accent-subtle px-2 py-1.5 font-semibold text-accent-text before:absolute before:inset-y-1.5 before:start-0 before:w-1 before:rounded-sm before:bg-accent">
              {t('nav.dashboard')}
            </li>
            <li className="rounded-md bg-accent-subtle px-2 py-1.5 text-fg">{t('nav.users')}</li>
            <li className="rounded-md px-2 py-1.5 text-fg-secondary">{t('nav.settings')}</li>
          </ul>
        </div>
        <div className="flex min-w-0 flex-col">
          <div
            data-preview-part="header"
            className="flex h-12 items-center gap-2 border-b border-line-subtle bg-surface-raised px-3"
          >
            <PreviewMark name={name} logos={logos} theme={theme} variant="compact" tools={tools} />
          </div>
          <div className="flex flex-col gap-4 p-3">
            {BUTTON_VARIANTS.map((variant) => (
              <PreviewButtons key={variant} variant={variant} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function LivePreview({ orgName, accent, logos }: LivePreviewProps) {
  const { t } = useTranslator();
  const tools = useBrandingTools();

  const normalisedName = tools === null ? null : tools.orgName.tryNormalizeOrgName(orgName);
  const normalisedAccent = tools === null ? null : tools.accent.tryNormalizeAccent(accent);

  // While the text is not a colour (or a name) the preview keeps the last one that was.
  const [lastName, setLastName] = useState<string | null>(null);
  if (normalisedName !== null && normalisedName !== lastName) setLastName(normalisedName);
  const [lastAccent, setLastAccent] = useState<string | null>(null);
  if (normalisedAccent !== null && normalisedAccent !== lastAccent) setLastAccent(normalisedAccent);

  const name = normalisedName ?? lastName ?? tools?.orgName.DEFAULT_ORG_NAME ?? null;
  const accentHex = normalisedAccent ?? lastAccent ?? tools?.tokens.DEFAULT_ACCENT ?? null;
  const derived = useMemo(
    () =>
      tools === null || accentHex === null ? null : tools.accent.deriveAccentTokens(accentHex),
    [tools, accentHex],
  );

  return (
    <section aria-labelledby="preview-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="preview-title" className="text-subtitle font-semibold text-fg">
          {t('preview.title')}
        </h2>
        <p className="text-body-sm text-fg-muted">{t('preview.description')}</p>
      </div>
      {tools === null || name === null || accentHex === null || derived === null ? (
        <div aria-busy="true" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {THEMES.map((theme) => (
            <PreviewPane
              key={theme}
              theme={theme}
              name={name}
              accent={derived[theme]}
              accentHex={derived[theme].accent}
              logos={logos}
              tools={tools}
            />
          ))}
        </div>
      )}
    </section>
  );
}
