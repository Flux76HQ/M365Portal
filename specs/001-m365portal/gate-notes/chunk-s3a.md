# Chunk s3a: open points, assumptions and risks (S3 shared core, T-A-120 to T-A-122)

Status: **tasks done, gate G3a passed** (evidence in `G3a.md`). S8 consolidates this note into `docs/open-points.md` (task `T-A-278`); no other stream edits that file. Entries say who acts and when.

## Open points

| # | Point | Owner | When |
|---|---|---|---|
| OP-1 | **The 3 % margin band.** FR-A-101 says a colour that satisfies the bounds "is used unchanged"; plan 10.4 step 2 applies the bounds with a 3 % margin for that decision (3.09:1 for the accent, 4.635:1 for accent text, 4.502:1 for text on the accent), so a colour at 3.00 to 3.09:1 against a surface is adjusted, minimally, although it would be allowed. `shared/accent.property.test.ts` encodes the plan. Either the FR-A-101 row gets the margin sentence or the plan drops the margin. | S8 / owner | spec amendment, `T-A-278` |
| OP-2 | **Near-black accents get a barely visible hover.** In the light theme a near-pure-black accent gets hover `#010101` and active `#020202` (for `#050a08` the active colour is `#000000`) because a step of 0.045 OKLab lightness is smaller than one 8-bit step at the dark end. AA is unaffected and the spec's "perceptible lightness step" is met in the OKLab sense. 3 of 24,096 sampled colours have a hover within seven levels of the accent, none in the dark theme. A visible floor needs a design decision (a lighter charcoal for black?) and a small change in `stepFrom`. | owner (design), S3 | palette review at G3 |
| OP-3 | **Mid-tone brands get black text.** 63 % of uniformly random colours get black text on the accent (plan 10.4 "design consequence"); 52 % (light) and 31 % (dark) are adjusted. The "darken until white text passes" mode of plan section 18 is still an owner decision. | owner | before the Appearance page is accepted (`T-A-216`) |
| OP-4 | **Default accent `#0078d4`** (assumption A-42, "a calm blue"). It is the plan's own example, clears every bound unchanged in both themes with white text, and equals a well-known vendor blue. One constant (`DEFAULT_ACCENT`) plus a regenerated stylesheet if the owner prefers another. | owner | palette review at G3 |
| OP-5 | **Edits for the orchestrator.** (a) `T-A-078` and `T-A-082` should list `T-A-122` under `Needs` (G0 decision 6: they weigh pixels with `srgbChannelToLinear` / `relativeLuminanceOfChannels` from `branding/contrast.ts` and need no `single-implementation` exemption). (b) Optional `"sideEffects": false` in `packages/shared/package.json` (S0's file) if `pnpm bundle:check` shows the tokens barrel pulling the derivation into the entry chunk. | orchestrator | before `T-A-078` starts; at `T-A-259` |
| OP-6 | **`RADIUS_FULL_USES` is a list, not a control.** Nothing scans web code for `rounded-full` outside avatars, switch thumbs and status dots. `web/styles.test.ts` (`T-A-123`) can add a source scan. | S3 (web) | `T-A-123` |
| OP-7 | **The exhaustive sweep is a one-off.** CI runs the committed property test (24,630 colours); the sweep over all 16,777,216 colours is not a job. Re-run it after any change to a surface in `tokens/colours.ts`, to `branding/accent.ts` or to `branding/contrast.ts` (recipe below). | S3, S7 (optional job) | on change |
| OP-8 | **Documentation to write.** `docs/architecture.md`: the token layers, the accent algorithm in one page (targets 3.09 / 4.635 / 4.502, the margin, OKLab steps 0.045 and 0.09, the verified walk, the pure black and white ends), the tests that guard it, and the variable vocabulary of `G3a.md` section 4.4. `docs/security.md`: `renderTokenCss` is the only producer of the CSS that the server injects into a nonce-carrying `<style>`; every colour is validated as `#rrggbb` and the output has a closed character set. | S8 | `T-A-274` onward |
| OP-9 | **Spec wording.** FR-A-120 says the tokens are "defined once as CSS variables through the Tailwind v4 theme". As built (PD-13): defined once in TypeScript, emitted as CSS variables by `renderTokenCss` / `tokens.generated.css`, mapped to utilities by `@theme` in `T-A-123`. Same intent, different sentence. | S8 | `T-A-001`-style spec pass |
| OP-10 | **`pnpm tokens:check` is not a CI step by name.** `shared/tokens.test.ts` already asserts that the committed stylesheet equals the generated one and spawns the real script against stale fixtures, so `pnpm test` fails on a stale file. A named `tokens:check` step in the `quality` job would make the control findable under the name the task uses. | S7 | `T-A-251` |
| OP-11 | **A failure outside this chunk.** `shared/repo-conventions.test.ts` check 5 reports `apps/server/src/config/env.ts:81`: a doc comment in S1's in-progress file contains the literal port 8080, and the guard reads comments (G0 section 13 warned about it). Seen in a clean copy and again on the live tree after a minute. S1 reword the comment; nothing in S3 can or should touch it. | S1 | before G1 |

## Assumptions

- A-1 The default accent is a calm blue defined once (A-42); the neutral and status colours of plan 10.2 are used as written (the test reproduces the plan's measured minima to two decimals).
- A-2 Text on the accent is pure black or pure white only; a softer black would break the 4.583:1 bound that holds by arithmetic.
- A-3 Layers that carry text keep an alpha of at least 0.92 (`MIN_TEXT_GLASS_ALPHA`), which is what allows the derivation to work against opaque surfaces only (FR-A-101).
- A-4 The dark theme is selected by `data-theme="dark"` on `<html>` and the boot script resolves "system" before first paint (FR-A-121); the tokens contain no `prefers-color-scheme` rule.
- A-5 Contrast is computed on 8-bit values, because that is what a screen shows.
- A-6 `rem` is relative to the browser default of 16 px (`ROOT_FONT_SIZE_PX`), so spacing and type follow the reader's text size.

## Risks

- R-1 **Engine rounding.** `**` and `Math.cbrt` are only approximately specified, so a colour may come out one 8-bit level apart on another engine or CPU (the image is built for arm64 too; browsers differ from V8 on Linux). The guarantee holds per engine, because each run verifies its own result before returning it; only the exact hex can differ. Derived tokens are never stored. The sweep ran on x64 V8 only.
- R-2 **Bundle weight** of the tokens barrel (it reaches the derivation, about 13 kB of source before minification). Modules do no work at import so a bundler should drop them where only constants are used; unmeasured until `T-A-259`.
- R-3 **Live preview versus stored value** can differ by one level (R-1); show the server's `tokens` after saving (`T-A-213`, `T-A-215`).
- R-4 **Injection order.** Solved by making the generated default colours zero-specificity (`:where`); a future change that writes the defaults as plain `:root` would make the order of the stylesheet link and the injected `<style>` matter again (Vite appends its link at the end of `<head>`). `shared/tokens.test.ts` asserts the `:where` form.
- R-5 **A surface change can make the derivation throw.** If a future surface no longer lets pure black (light) or pure white (dark) clear 3 x 1.03, `deriveAccentTokens` throws a named error for some colours instead of returning a bad one; `shared/tokens.test.ts` asserts that precondition so the change fails there first.

## Re-running the exhaustive sweep

The sweep is the oracle of `shared/accent.property.test.ts` (an 8-bit linearisation folded into constants and an OKLab lightness by way of XYZ) applied to every `n` from 0 to 16,777,215, in both themes, with the same bounds, margins and minimality checks as the committed test. Three processes at `nice -n 19` take about 20 minutes on an idle machine (about 200 microseconds per colour). It was run from the scratchpad with `tsx`; the script is below so that it can be recreated.

```ts
// One-off exhaustive sweep (not repository code): every #rrggbb colour, both themes, the oracle of
// shared/accent.property.test.ts (copied here, written independently of branding/*.ts).
import { appendFileSync, writeFileSync } from 'node:fs';
import { SURFACES, SURFACE_NAMES } from '<repo>/packages/shared/src/tokens/index.ts';
import { deriveAccentTokens } from '<repo>/packages/shared/src/branding/accent.ts';

const [startArg, endArg, logPath] = process.argv.slice(2);
const start = Number(startArg), end = Number(endArg);
const lin = (v: number) => (v <= 10 ? v / 3294.6 : ((v + 14.025) / 269.025) ** 2.4);
const LIN = Array.from({ length: 256 }, (_, i) => lin(i));
const lumOf = (n: number) => 0.2126 * LIN[(n >> 16) & 255]! + 0.7152 * LIN[(n >> 8) & 255]! + 0.0722 * LIN[n & 255]!;
const num = (hex: string) => Number.parseInt(hex.slice(1), 16);
const con = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const okL = (n: number) => {
  const r = LIN[(n >> 16) & 255]!, g = LIN[(n >> 8) & 255]!, b = LIN[n & 255]!;
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b, y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b, z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const l = 0.8189330101 * x + 0.3618667424 * y - 0.1288597137 * z, m = 0.0329845436 * x + 0.9293118715 * y + 0.0361456387 * z, s = 0.0482003018 * x + 0.2643662691 * y + 0.633851707 * z;
  return 0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s);
};
const HEX = /^#[0-9a-f]{6}$/;
const surf = { light: SURFACE_NAMES.map((k) => lumOf(num(SURFACES.light[k]))), dark: SURFACE_NAMES.map((k) => lumOf(num(SURFACES.dark[k]))) };

let violations = 0, adjustedLight = 0, adjustedDark = 0, minStep = 9, minAccent = 99, minText = 99, minOn = 99, minRing = 99, minSubtle = 99;
const first: string[] = [];
const bad = (hex: string, theme: string, why: string) => { violations++; if (first.length < 40) first.push(`${hex} ${theme}: ${why}`); };
const t0 = Date.now();
writeFileSync(logPath!, `start ${start} end ${end}\n`);
for (let n = start; n < end; n++) {
  const hex = '#' + n.toString(16).padStart(6, '0');
  const tokens = deriveAccentTokens(hex);
  for (const theme of ['light', 'dark'] as const) {
    const t = tokens[theme];
    const S = surf[theme];
    let ok = true;
    for (const f of ['accent', 'accentHover', 'accentActive', 'accentSubtle', 'onAccent', 'accentText', 'focusRing'] as const) if (!HEX.test(t[f])) { bad(hex, theme, `${f} format`); ok = false; }
    if (!ok) continue;
    const a = num(t.accent), tx = num(t.accentText), fr = num(t.focusRing), on = num(t.onAccent), sub = num(t.accentSubtle);
    let lowestChosen = 99;
    for (const s of S) {
      const ca = con(lumOf(a), s), ct = con(lumOf(tx), s), cf = con(lumOf(fr), s);
      if (ca < 3) bad(hex, theme, `accent vs surface ${ca}`);
      if (ct < 4.5) bad(hex, theme, `accentText vs surface ${ct}`);
      if (cf < 3) bad(hex, theme, `focusRing vs surface ${cf}`);
      minAccent = Math.min(minAccent, ca); minText = Math.min(minText, ct); minRing = Math.min(minRing, cf);
      lowestChosen = Math.min(lowestChosen, con(lumOf(n), s));
    }
    for (const f of ['accent', 'accentHover', 'accentActive'] as const) {
      const c = con(lumOf(on), lumOf(num(t[f])));
      if (c < 4.5) bad(hex, theme, `onAccent vs ${f} ${c}`);
      minOn = Math.min(minOn, c);
    }
    const cs = con(lumOf(tx), lumOf(sub));
    if (cs < 4.5) bad(hex, theme, `accentText vs subtle ${cs}`);
    minSubtle = Math.min(minSubtle, cs);
    if (t.onAccent !== '#ffffff' && t.onAccent !== '#000000') bad(hex, theme, 'onAccent not pure');
    for (const f of ['accentHover', 'accentActive'] as const) {
      const st = Math.abs(okL(a) - okL(num(t[f])));
      minStep = Math.min(minStep, st);
      if (st < 0.029) bad(hex, theme, `${f} step ${st}`);
    }
    if (t.adjusted && t.accent === hex) bad(hex, theme, 'adjusted but unchanged');
    if (!t.adjusted && t.accent !== hex) bad(hex, theme, 'unchanged colour altered');
    if (lowestChosen >= 3 * 1.03 && t.accent !== hex) bad(hex, theme, `compliant colour changed (${lowestChosen})`);
    if (lowestChosen < 3 && !t.adjusted) bad(hex, theme, `failing colour not adjusted (${lowestChosen})`);
    if (t.adjusted) { if (theme === 'light') adjustedLight++; else adjustedDark++; }
  }
  if ((n - start) % 500000 === 499999) appendFileSync(logPath!, `${n + 1 - start} done, ${((Date.now() - t0) / 1000).toFixed(0)}s, violations ${violations}\n`);
}
const summary = { start, end, count: end - start, seconds: (Date.now() - t0) / 1000, violations, adjustedLight, adjustedDark, minStep, minAccent, minText, minOn, minRing, minSubtle, first };
appendFileSync(logPath!, 'DONE ' + JSON.stringify(summary) + '\n');
```

Usage: `tsx exhaustive.ts <first> <end> <logfile>` with the repository path filled in for `<repo>`; split 0 to 16,777,216 over as many processes as there are idle cores. Result of the run recorded in `G3a.md` section 5.
