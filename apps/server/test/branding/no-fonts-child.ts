// The child process of `icons-no-fonts.test.ts`. It runs with an environment that has an EMPTY font
// configuration (set by the test: `FONTCONFIG_FILE` names a valid fontconfig document that lists no
// font directory), renders the monogram icons through the production code, and also renders an SVG
// that DOES need a font as the control: if the control draws text, the environment has fonts and the
// test proves nothing. Prints one JSON line: the 512 icon, the control's count of text pixels.
//
// A separate process because fontconfig is initialised once per process, on the first text render;
// the test process has its own (host) configuration and cannot be switched.
import sharp from 'sharp';
import { composeIcons } from '../../src/branding/pipeline/icons.js';

const CONTROL_SIZE = 512;
const controlSvg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${String(CONTROL_SIZE)}" height="${String(CONTROL_SIZE)}">`,
  `<rect width="${String(CONTROL_SIZE)}" height="${String(CONTROL_SIZE)}" fill="#0078d4"/>`,
  '<text x="40" y="360" font-size="320" font-family="sans-serif" font-weight="bold" fill="#ffffff">AC</text>',
  '</svg>',
].join('');

const set = await composeIcons({
  orgName: process.argv[2] ?? 'Acme Corp',
  accent: '#0078d4',
  light: null,
  dark: null,
  compact: null,
});

const { data } = await sharp(Buffer.from(controlSvg)).ensureAlpha().raw().toBuffer({
  resolveWithObject: true,
});
let controlTextPixels = 0;
for (let offset = 0; offset < data.length; offset += 4) {
  if ((data[offset] ?? 0) > 200 && (data[offset + 1] ?? 0) > 200) controlTextPixels += 1;
}

process.stdout.write(
  `${JSON.stringify({
    pwa512: set.icons.pwa512.png.toString('base64'),
    favicon32: set.icons.favicon32.png.toString('base64'),
    controlTextPixels,
  })}\n`,
);
