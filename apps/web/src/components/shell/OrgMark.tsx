import {
  logoPlateColour,
  logoPlateFor,
  type LogoPlate,
} from '@m365portal/shared/branding/logo-plate';
import { PRODUCT_NAME } from '@m365portal/shared';
import type { Branding } from '@m365portal/shared/schemas/branding';
import { cn } from '../../lib/cn';
import { useBranding } from '../../lib/router-context';
import { useTheme, type ResolvedTheme } from '../../lib/theme';

type Logo = NonNullable<Branding['logos']['light']>;
type MonogramGlyph = Branding['monogram']['glyphs'][number];

export interface OrgMarkProps {
  /** `full` is the logo (or tile) and the name; `compact` is the compact logo (or tile) and, if asked, the name. */
  readonly variant: 'full' | 'compact';
  /** Show the name beside a compact mark (the header below 768 px). A `full` mark always shows it. */
  readonly showName?: boolean;
  readonly className?: string;
}

/**
 * The logo for this theme: the one made for it, else the other one (one logo serves both themes, A-39).
 * The compact variant wins when a compact mark is wanted.
 */
export function pickLogo(
  logos: Branding['logos'],
  theme: ResolvedTheme,
  variant: OrgMarkProps['variant'],
): Logo | null {
  const full = theme === 'dark' ? (logos.dark ?? logos.light) : (logos.light ?? logos.dark);
  return variant === 'compact' ? (logos.compact ?? full) : full;
}

function MonogramTile({
  monogram,
  label,
}: {
  readonly monogram: OrgMarkSource['monogram'];
  /** The accessible name; null when the name is written beside the tile, so it is not read twice. */
  readonly label: string | null;
}) {
  const last = monogram.glyphs[monogram.glyphs.length - 1];
  const width = last === undefined ? 1000 : last.x + last.advance;
  // The glyph box is 1000 units from cap line to baseline; round glyphs overshoot by about 14. The
  // margin keeps the letters off the edge of the tile.
  const margin = 360;
  return (
    <span
      {...(label === null ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      data-slot="monogram-tile"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent forced-colors:border"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`${String(-margin)} ${String(-margin)} ${String(width + 2 * margin)} ${String(1000 + 2 * margin)}`}
        className="size-full fill-current"
      >
        {monogram.glyphs.map((glyph) => (
          <path
            key={`${glyph.key}-${String(glyph.x)}`}
            d={glyph.path}
            transform={`translate(${String(glyph.x)} 0)`}
          />
        ))}
      </svg>
    </span>
  );
}

function LogoImage({
  logo,
  label,
  plate,
}: {
  readonly logo: Logo;
  /** The alternative text; empty when the name is written beside the logo, so it is not read twice. */
  readonly label: string;
  readonly plate: LogoPlate;
}) {
  return (
    <span
      data-slot="logo"
      data-plate={plate}
      className={cn(
        'inline-flex h-8 max-w-40 shrink-0 items-center rounded-md',
        plate === 'none' ? '' : 'px-1.5 py-1',
      )}
      style={plate === 'none' ? undefined : { backgroundColor: logoPlateColour(plate) }}
    >
      <img
        src={logo.url}
        alt={label}
        width={logo.width}
        height={logo.height}
        className="h-full max-h-8 w-auto max-w-full object-contain"
      />
    </span>
  );
}

/** What the mark draws: the name, the logos and the monogram of a branding (or of a draft of one). */
export interface OrgMarkSource {
  readonly orgName: string;
  readonly logos: Branding['logos'];
  readonly monogram: { readonly glyphs: readonly MonogramGlyph[] };
}

export interface OrgMarkViewProps {
  /** The branding to draw, or undefined while it is not loaded (the name of the product, no mark). */
  readonly branding: OrgMarkSource | undefined;
  /** The theme to draw it for: the shell passes the resolved theme, the live preview one pane each. */
  readonly theme: ResolvedTheme;
  readonly variant: OrgMarkProps['variant'];
  readonly showName?: boolean;
  readonly className?: string;
}

/**
 * The organisation mark (FR-A-092, US-2): the uploaded logo, on a plate where it would be illegible on
 * the sidebar and never recoloured, or the monogram tile of the saved name. The name is data and is never
 * translated; a long one is cut with an ellipsis and keeps its full text for assistive technology.
 *
 * Pure: it reads nothing from the application. The shell mark (`OrgMark`) feeds it the saved branding and
 * the resolved theme; the live preview of the Appearance page feeds it a draft and one theme per pane.
 */
export function OrgMarkView({
  branding,
  theme,
  variant,
  showName = variant === 'full',
  className,
}: OrgMarkViewProps) {
  const name = branding?.orgName ?? PRODUCT_NAME;
  const logo = branding === undefined ? null : pickLogo(branding.logos, theme, variant);
  const nameShown = showName || branding === undefined;
  // The mark names the organisation only when no text does.
  const markName = nameShown ? null : name;

  return (
    <span data-slot="org-mark" className={cn('flex min-w-0 items-center gap-3', className)}>
      {logo !== null ? (
        <LogoImage logo={logo} label={markName ?? ''} plate={logoPlateFor(logo.luminance, theme)} />
      ) : branding !== undefined ? (
        <MonogramTile monogram={branding.monogram} label={markName} />
      ) : null}
      {nameShown ? (
        // `bdi` isolates a name in the other direction from the text around it.
        <bdi
          data-slot="org-name"
          title={name}
          className="block min-w-0 truncate text-subtitle font-semibold text-fg"
        >
          {name}
        </bdi>
      ) : null}
    </span>
  );
}

/** The mark of the saved branding in the theme that is applied (the shell: sidebar and header). */
export function OrgMark({ variant, showName, className }: OrgMarkProps) {
  const branding = useBranding();
  const { resolved } = useTheme();
  return (
    <OrgMarkView
      branding={branding}
      theme={resolved}
      variant={variant}
      {...(showName === undefined ? {} : { showName })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
