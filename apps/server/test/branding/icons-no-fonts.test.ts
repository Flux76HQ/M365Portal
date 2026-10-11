// No icon code path touches a system font (T-A-082; FR-A-092; E-13; probe P22). The runtime image
// has no fonts and no fontconfig, and SVG `<text>` does not render there, so the monogram is drawn
// from the pre-generated glyph paths.
//
// Two controls:
//   1. A child process whose font configuration is EMPTY renders the monogram icons through the
//      production code, and they still hold glyph pixels. In the same process an SVG that does need
//      a font renders (almost) no text: that is the proof that this environment really has no fonts,
//      so the glyph pixels cannot have come from one. (Why a child: fontconfig is initialised once
//      per process on the first text render.)
//   2. The icon modules contain no text element, font family, font size or font file; the scan runs
//      on a fixture that must fail first.
//
// "An empty font configuration" is a fontconfig document that lists no font directory. A zero-byte
// file is not one: fontconfig cannot parse it, falls back to its built-in directories and finds the
// host's fonts (checked on the development host, where Inter is installed system-wide).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { parseHexColour } from '@m365portal/shared/branding/contrast';
import { expectGuardFails } from '@m365portal/shared/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EMPTY_FONT_CONFIGURATION =
  '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n</fontconfig>\n';

const childPath = fileURLToPath(new URL('./no-fonts-child.ts', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;

interface ChildReport {
  readonly pwa512: string;
  readonly favicon32: string;
  readonly controlTextPixels: number;
}

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'm365portal-no-fonts-'));
  await writeFile(join(workDir, 'empty-fonts.conf'), EMPTY_FONT_CONFIGURATION);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function renderWithoutFonts(orgName: string): Promise<ChildReport> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', tsxLoader, childPath, orgName],
      {
        // Nothing of this process's environment: no PATH, no HOME, no XDG directory, and a font
        // configuration that names no font directory.
        env: {
          FONTCONFIG_FILE: join(workDir, 'empty-fonts.conf'),
          FONTCONFIG_PATH: workDir,
          HOME: workDir,
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      },
      (failure, stdout, stderr) => {
        if (failure !== null) {
          reject(new Error(`the child failed: ${failure.message}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout.trim()) as ChildReport);
      },
    );
  });
}

async function pixelsOf(png: string): Promise<{
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}> {
  const { data, info } = await sharp(Buffer.from(png, 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function countPixels(
  image: { readonly data: Buffer },
  colour: readonly [number, number, number],
  tolerance = 2,
): number {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      colour.every(
        (channel, index) => Math.abs((image.data[offset + index] ?? 999) - channel) <= tolerance,
      )
    ) {
      count += 1;
    }
  }
  return count;
}

describe('icons without fonts', () => {
  it('renders the monogram with an empty font configuration and the tile is not uniform', async () => {
    const report = await renderWithoutFonts('Acme Corp');

    // The control: an SVG that needs a font draws no text here (a few stray pixels at most), so
    // this environment has no fonts to fall back on.
    expect(report.controlTextPixels).toBeLessThan(0.005 * 512 * 512);

    const { accent, onAccent } = deriveAccentTokens('#0078d4').light;
    for (const [name, png, size] of [
      ['pwa512', report.pwa512, 512],
      ['favicon32', report.favicon32, 32],
    ] as const) {
      const image = await pixelsOf(png);
      expect([image.width, image.height]).toEqual([size, size]);
      const tile = countPixels(image, parseHexColour(accent), 1);
      const glyph = countPixels(image, parseHexColour(onAccent), 1);
      // A uniform tile would be all accent. The glyphs "AC" cover a fifth or so of a 512 tile.
      expect(tile, `${name} tile`).toBeGreaterThan(0);
      expect(glyph, `${name} glyph pixels`).toBeGreaterThan(size === 512 ? 20_000 : 40);
      expect(glyph / (size * size), `${name} glyph share`).toBeLessThan(0.5);
    }
    // And the glyph pixels outnumber what a font would have drawn here by a wide margin.
    const big = await pixelsOf(report.pwa512);
    expect(countPixels(big, parseHexColour(onAccent), 1)).toBeGreaterThan(
      report.controlTextPixels * 50,
    );
  }, 60_000);

  it('draws the pictogram without fonts too (a name with no letter)', async () => {
    const report = await renderWithoutFonts('株式会社');
    const image = await pixelsOf(report.pwa512);
    const glyph = countPixels(
      image,
      parseHexColour(deriveAccentTokens('#0078d4').light.onAccent),
      1,
    );
    expect(glyph).toBeGreaterThan(15_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The icon code never asks for a font
// ---------------------------------------------------------------------------------------------

const FONT_USE = [
  [/<\s*text[\s>/]/i, '<text'],
  [/<\s*tspan[\s>/]/i, '<tspan'],
  [/font-family/i, 'font-family'],
  [/font-size/i, 'font-size'],
  [/font-weight/i, 'font-weight'],
  [/fontconfig/i, 'fontconfig'],
  [/\bfontfile\b/i, 'fontfile'],
  [/\.(?:ttf|otf|woff2?)\b/i, 'a font file'],
  [/\btext\s*:\s*\{/, 'a Pango text option'],
] as const;

/** Throws when the source asks for a font anywhere. */
function assertNoFontUse(source: string): void {
  for (const [pattern, label] of FONT_USE) {
    if (pattern.test(source)) throw new Error(`the icon code uses a font: ${label}`);
  }
}

const iconModules = ['icons.ts', 'monogram-render.ts', 'plate.ts'] as const;

describe('the icon modules never ask for a font', () => {
  it.each(iconModules)('%s has no text element, font family, size or file', async (name) => {
    const source = await readFile(
      fileURLToPath(new URL(`../../src/branding/pipeline/${name}`, import.meta.url)),
      'utf8',
    );
    // The scan reads code, not the prose that explains why there is none.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(() => {
      assertNoFontUse(code);
    }).not.toThrow();
  });

  it('fails on source that does (negative fixtures)', () => {
    for (const bad of [
      'const svg = `<svg><text x="1" y="2">A</text></svg>`;',
      "const svg = '<tspan>A</tspan>';",
      "const style = 'font-family: Inter, sans-serif';",
      'const size = "font-size: 20px";',
      "sharp({ text: { text: 'A', font: 'Inter', fontfile: '/x/inter.ttf' } });",
      "const file = '/usr/share/fonts/inter.woff2';",
      "process.env.FONTCONFIG_FILE = '/etc/fonts/fonts.conf';",
    ]) {
      expectGuardFails(assertNoFontUse, bad, { reason: 'the icon code uses a font' });
    }
  });
});
