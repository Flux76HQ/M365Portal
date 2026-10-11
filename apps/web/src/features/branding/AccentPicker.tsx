import { CheckIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/cn';
import { useTranslator } from '../../lib/locale';
import { translateProblemCode } from '../../lib/problem';
import { ColourChip } from './ColourChip';
import { useBrandingTools, type BrandingTools } from './tools';

// The accent picker (T-A-211; FR-A-132, FR-A-103; E-03, E-04; US-2.3).
//
// A hex field that accepts #rgb and #rrggbb in any case and shows what will be saved, a native colour
// input, eight suggested colours, and for each theme the chosen colour next to the colour that is
// actually used. The used colour comes from `deriveAccentTokens` (the one derivation, shared with the
// server): a colour that would not be readable is moved, and the text says so in words. Nothing here
// ever blocks saving: an unreadable colour is adjusted, not refused.
//
// The shared derivation is imported lazily (tools.ts); until it is there the picker shows its frame.

export interface AccentPickerProps {
  /** The text of the hex field: what the person typed, or the normalised colour. */
  readonly value: string;
  /** Called with the new text of the field (typing, a swatch, the native input, the blur that normalises). */
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  /** A message from outside (the server's `accent_invalid`, already translated). */
  readonly error?: string;
}

type SwatchName = 'blue' | 'teal' | 'green' | 'orange' | 'red' | 'pink' | 'purple' | 'graphite';

// The suggested colours as hue, saturation and lightness: the hex codes are computed, so no colour is
// written as a literal in the web code (FR-A-009). The first is the product's default accent.
const SWATCHES: readonly {
  readonly name: SwatchName;
  readonly hsl: readonly [number, number, number] | null;
}[] = Object.freeze([
  { name: 'blue', hsl: null },
  { name: 'teal', hsl: [178, 90, 29] },
  { name: 'green', hsl: [140, 60, 28] },
  { name: 'orange', hsl: [24, 90, 42] },
  { name: 'red', hsl: [2, 70, 46] },
  { name: 'pink', hsl: [330, 70, 46] },
  { name: 'purple', hsl: [270, 55, 48] },
  { name: 'graphite', hsl: [215, 12, 36] },
]);

function hslToHex(
  tools: BrandingTools,
  [hue, saturation, lightness]: readonly [number, number, number],
): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const channel = (offset: number): number => {
    const k = (offset + hue / 30) % 12;
    const value = l - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255);
  };
  return tools.contrast.formatHexColour(channel(0), channel(8), channel(4));
}

function swatchColours(
  tools: BrandingTools,
): readonly { readonly name: SwatchName; readonly hex: string }[] {
  return SWATCHES.map(({ name, hsl }) => ({
    name,
    hex: hsl === null ? tools.tokens.DEFAULT_ACCENT : hslToHex(tools, hsl),
  }));
}

const THEMES = ['light', 'dark'] as const;

function weakestAgainstSurfaces(
  tools: BrandingTools,
  theme: (typeof THEMES)[number],
  accent: string,
): number {
  const surfaces = Object.values(tools.tokens.SURFACES[theme]);
  return Math.min(...surfaces.map((surface) => tools.contrast.contrastRatio(accent, surface)));
}

export function AccentPicker({ value, onChange, disabled = false, error }: AccentPickerProps) {
  const { t, n } = useTranslator();
  const tools = useBrandingTools();
  const [touched, setTouched] = useState(false);

  const normalised = tools === null ? null : tools.accent.tryNormalizeAccent(value);
  // The native input needs a valid colour at all times: it keeps the last one while the text is not one.
  const [lastValid, setLastValid] = useState<string | null>(null);
  if (normalised !== null && normalised !== lastValid) setLastValid(normalised);

  const derived = useMemo(
    () =>
      tools === null || normalised === null ? null : tools.accent.deriveAccentTokens(normalised),
    [tools, normalised],
  );
  const swatches = useMemo(() => (tools === null ? [] : swatchColours(tools)), [tools]);

  const invalid = tools !== null && touched && normalised === null;
  const message = error ?? (invalid ? translateProblemCode({ t }, 'accent_invalid') : undefined);
  const nativeValue = normalised ?? lastValid ?? tools?.tokens.DEFAULT_ACCENT ?? undefined;

  const change = (next: string): void => {
    setTouched(true);
    onChange(next);
  };

  return (
    <section aria-labelledby="accent-title" className="flex flex-col gap-5">
      <h2 id="accent-title" className="text-subtitle font-semibold text-fg">
        {t('accent.title')}
      </h2>

      <FormField
        label={t('accent.hexLabel')}
        hint={t('accent.hexHint')}
        {...(message === undefined ? {} : { error: message })}
      >
        {(control) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t('accent.nativeLabel')}
                value={nativeValue}
                disabled={disabled}
                onChange={(event) => {
                  change(event.target.value);
                }}
                className="h-control w-12 shrink-0 cursor-pointer rounded-md border border-line-control bg-surface-raised p-1 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Input
                {...control}
                value={value}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                className="max-w-48 font-mono"
                onChange={(event) => {
                  change(event.target.value);
                }}
                onBlur={() => {
                  setTouched(true);
                  if (normalised !== null && normalised !== value) onChange(normalised);
                }}
              />
            </div>
            {normalised !== null && normalised !== value ? (
              <p role="status" className="text-body-sm text-fg-secondary">
                {t('accent.normalized', { hex: normalised })}
              </p>
            ) : null}
          </div>
        )}
      </FormField>

      <div
        role="group"
        aria-label={t('accent.swatchesLabel')}
        className="flex flex-wrap gap-2"
        aria-busy={tools === null}
      >
        {swatches.map(({ name, hex }) => {
          const selected = normalised === hex;
          return (
            <button
              key={name}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={t('accent.swatchName', { name: t(`accent.swatch.${name}`), hex })}
              onClick={() => {
                change(hex);
              }}
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-md p-1',
                'outline-offset-2 transition-shadow duration-fast ease-standard',
                'focus-visible:outline-2 focus-visible:outline-focus-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
                selected ? 'ring-2 ring-fg' : 'ring-1 ring-line-control',
              )}
            >
              <ColourChip colour={hex} className="size-6">
                {selected ? (
                  <CheckIcon
                    aria-hidden="true"
                    className="size-4 rounded-full bg-surface-raised p-0.5 text-fg"
                  />
                ) : null}
              </ColourChip>
            </button>
          );
        })}
      </div>

      {tools !== null && normalised !== null && derived !== null ? (
        <section aria-labelledby="accent-result-title" className="flex flex-col gap-3">
          <h3 id="accent-result-title" className="text-body font-medium text-fg">
            {t('accent.resultTitle')}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {THEMES.map((theme) => {
              const set = derived[theme];
              return (
                <div
                  key={theme}
                  role="group"
                  aria-label={t(`accent.theme.${theme}`)}
                  data-theme-result={theme}
                  className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-surface-raised p-3"
                >
                  <p className="text-body-sm font-semibold text-fg">{t(`accent.theme.${theme}`)}</p>
                  <p className="flex items-center gap-2 text-body-sm text-fg">
                    <ColourChip colour={normalised} />
                    <span>{t('accent.chosen', { hex: normalised })}</span>
                  </p>
                  <p className="flex items-center gap-2 text-body-sm text-fg">
                    <ColourChip colour={set.accent} />
                    <span>{t('accent.effective', { hex: set.accent })}</span>
                  </p>
                  <p className="text-body-sm text-fg-secondary">
                    {set.adjusted ? t('accent.explainAdjusted') : t('accent.explainSame')}
                  </p>
                  <p className="text-caption text-fg-muted">
                    {t('accent.contrast', {
                      ratio: n(weakestAgainstSurfaces(tools, theme, set.accent), {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }),
                    })}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </section>
  );
}
