// SVG rasterisation (T-A-081; FR-A-088; PD-09; R-06; H-04, H-05, H-08, H-19). The sanitised SVG is
// rasterised by sharp and discarded: what is stored is a PNG, sized from the view box, never from the
// size the file declares, and no connection is made while it happens. The tests run the real sharp.
//
// The renderer is also fed RAW hostile SVGs, without the sanitiser in front: the probe of the stack
// found that sharp loads no external reference, and these tests pin that, so the claim does not rest
// on the sanitiser alone (defence in depth, the other way round).
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PipelineError } from '../../src/branding/pipeline/errors.js';
import { assertCleanPng } from '../../src/branding/pipeline/raster.js';
import { SVG_NAMESPACE } from '../../src/branding/pipeline/svg/parse.js';
import { rebuildSvg } from '../../src/branding/pipeline/svg/rebuild.js';
import { renderSvg } from '../../src/branding/pipeline/svg/render.js';
import { startLocalListener } from '../helpers/local-listener.js';
import { fixtureById } from '../fixtures/hostile-corpus.js';
import { utf8, type HostileFixture, type HostileId } from '../fixtures/hostile/types.js';

/** The fixture of the corpus, or a failure that names the missing id. */
function fixtureOf(id: string): HostileFixture {
  const found = fixtureById(id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

const doc = (attributes: string, body: string): string =>
  `<svg xmlns="${SVG_NAMESPACE}"${attributes}>${body}</svg>`;

const BLUE = '<rect x="0" y="0" width="100" height="50" fill="#0000ff"/>';

async function pixels(png: Uint8Array) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): readonly number[] => {
    const offset = (Math.floor(y) * info.width + Math.floor(x)) * 4;
    return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, data[offset + 3] ?? 0];
  };
  return { width: info.width, height: info.height, at };
}

async function codeOf(job: Promise<unknown>): Promise<string> {
  try {
    await job;
  } catch (failure) {
    if (failure instanceof PipelineError) return failure.code;
    throw failure;
  }
  return 'accepted';
}

async function rawInputs(id: HostileId, origin: string): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  const context = { listenerOrigin: origin, workDir: '/nonexistent/m365portal-render' };
  for (const input of fixtureOf(id).inputs) {
    if (input.kind === 'upload') found.set(input.label, await input.bytes(context));
  }
  return found;
}

describe('renderSvg: the picture', () => {
  it('draws the shapes at the size the sanitiser wrote and nothing else', async () => {
    const { svg, width, height } = rebuildSvg(utf8(doc(' viewBox="0 0 100 50"', BLUE)), {
      bound: 512,
    });
    const png = await renderSvg(svg, 512);
    expect([png.width, png.height]).toEqual([width, height]);
    expect([png.width, png.height]).toEqual([512, 256]);
    const picture = await pixels(png.png);
    expect(picture.at(256, 128)).toEqual([0, 0, 255, 255]);
    expect(picture.at(1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('leaves what the drawing does not cover transparent', async () => {
    const { svg } = rebuildSvg(
      utf8(doc(' viewBox="0 0 100 100"', '<circle cx="50" cy="50" r="20" fill="#ff0000"/>')),
      { bound: 128 },
    );
    const picture = await pixels((await renderSvg(svg, 128)).png);
    expect(picture.at(64, 64)).toEqual([255, 0, 0, 255]);
    expect(picture.at(2, 2)[3]).toBe(0);
    expect(picture.at(125, 125)[3]).toBe(0);
  });

  it('fits the bound whatever the shape: 512 for a logo, 128 for the compact variant', async () => {
    for (const [bound, viewBox, expected] of [
      [512, '0 0 100 50', [512, 256]],
      [512, '0 0 50 100', [256, 512]],
      [512, '0 0 1000000 1', [512, 1]],
      [128, '0 0 100 50', [128, 64]],
      [128, '0 0 1 1000000', [1, 128]],
      [128, '-50 -50 100 100', [128, 128]],
    ] as const) {
      const { svg } = rebuildSvg(
        utf8(
          doc(
            ` viewBox="${viewBox}"`,
            '<rect x="-50" y="-50" width="1000000" height="1000000" fill="#00ff00"/>',
          ),
        ),
        { bound },
      );
      const png = await renderSvg(svg, bound);
      expect([png.width, png.height], `${String(bound)} ${viewBox}`).toEqual(expected);
      assertCleanPng({ png: png.png, maxDimension: bound });
    }
  });

  it('scales a small drawing up to fill the bound (vector, no enlargement artefacts)', async () => {
    const { svg } = rebuildSvg(
      utf8(
        doc(
          ' viewBox="0 0 2 2"',
          '<rect width="1" height="2" fill="#ff0000"/><rect x="1" width="1" height="2" fill="#0000ff"/>',
        ),
      ),
      { bound: 128 },
    );
    const picture = await pixels((await renderSvg(svg, 128)).png);
    expect([picture.width, picture.height]).toEqual([128, 128]);
    expect(picture.at(31, 64)).toEqual([255, 0, 0, 255]);
    expect(picture.at(96, 64)).toEqual([0, 0, 255, 255]);
  });

  it('draws gradients, clip paths, masks and use, which the allowlist keeps', async () => {
    const { svg } = rebuildSvg(
      utf8(
        doc(
          ' viewBox="0 0 100 100"',
          '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>' +
            '<clipPath id="c"><rect width="50" height="100"/></clipPath><g id="u"><rect width="100" height="100" fill="url(#g)" clip-path="url(#c)"/></g></defs><use href="#u"/>',
        ),
      ),
      { bound: 100 },
    );
    const picture = await pixels((await renderSvg(svg, 100)).png);
    expect(picture.at(2, 50)[0]).toBeGreaterThan(200);
    expect(picture.at(48, 50)[2]).toBeGreaterThan(90);
    expect(picture.at(75, 50)[3]).toBe(0);
  });

  it('refuses a drawing with nothing visible as image_empty', async () => {
    const { svg } = rebuildSvg(
      utf8(doc(' viewBox="0 0 10 10"', '<rect width="10" height="10" fill="none"/>')),
      { bound: 128 },
    );
    expect(await codeOf(renderSvg(svg, 128))).toBe('image_empty');
    const transparent = rebuildSvg(
      utf8(
        doc(' viewBox="0 0 10 10"', '<rect width="10" height="10" fill="#f00" fill-opacity="0"/>'),
      ),
      { bound: 128 },
    );
    expect(await codeOf(renderSvg(transparent.svg, 128))).toBe('image_empty');
  });
});

describe('renderSvg: what is stored is a PNG', () => {
  it('returns PNG bytes that pass the self-check, with no trace of SVG or of the source', async () => {
    const { svg } = rebuildSvg(
      utf8(doc(' viewBox="0 0 100 50"', `<title>M365HOSTILE-81-title</title>${BLUE}`)),
      { bound: 512 },
    );
    const { png } = await renderSvg(svg, 512);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assertCleanPng({ png, maxDimension: 512 });
    const text = Buffer.from(png).toString('latin1');
    expect(text).not.toMatch(/<svg|<\/svg|xmlns|M365HOSTILE/);
    expect((await sharp(png).metadata()).format).toBe('png');
  });

  it('is deterministic', async () => {
    const { svg } = rebuildSvg(utf8(doc(' viewBox="0 0 100 50"', BLUE)), { bound: 512 });
    const first = await renderSvg(svg, 512);
    const second = await renderSvg(svg, 512);
    expect(Buffer.compare(first.png, second.png)).toBe(0);
  });

  it('fails the self-check when the encoder is asked for more than the bound (negative)', async () => {
    const { svg } = rebuildSvg(utf8(doc(' viewBox="0 0 100 50"', BLUE)), { bound: 512 });
    await expectGuardFails(() => renderSvg(svg, 128), undefined, { reason: 'outside the bound' });
  });
});

describe('renderSvg: the size comes from the view box, never from the declared size (H-19)', () => {
  it('renders the sanitised H-19 files at the bounded size within the budget', async () => {
    const found = await rawInputs('H-19', 'http://127.0.0.1:9');
    const outcomes: Record<string, string> = {};
    for (const [label, bytes] of found) {
      const start = performance.now();
      outcomes[label] = await codeOf(
        (async () => {
          const { svg } = rebuildSvg(bytes, { bound: 512 });
          const png = await renderSvg(svg, 512);
          expect(Math.max(png.width, png.height), label).toBeLessThanOrEqual(512);
        })(),
      );
      expect(performance.now() - start, label).toBeLessThan(2_000);
    }
    expect(outcomes).toEqual({
      'width-height-1e9': 'accepted',
      'viewbox-1e9': 'svg_too_complex',
      'both-extreme': 'svg_too_complex',
    });
  });

  it('keeps even a raw file with a huge declared size bounded: rendered small or refused, in milliseconds', async () => {
    for (const attributes of [
      ' width="1e9" height="1e9" viewBox="0 0 100 100"',
      ' width="60000" height="60000"',
      ' width="1e9" height="1e9"',
      ' width="4097" height="4097"',
    ]) {
      const start = performance.now();
      let produced: { width: number; height: number } | string;
      try {
        produced = await renderSvg(doc(attributes, BLUE), 512);
      } catch (failure) {
        if (!(failure instanceof PipelineError)) throw failure;
        produced = failure.code;
      }
      expect(performance.now() - start, attributes).toBeLessThan(2_000);
      if (typeof produced === 'string') {
        // A declared size the library cannot take is clamped to a pixel, which shows nothing: image_empty.
        expect(['svg_too_complex', 'image_corrupt', 'image_empty'], attributes).toContain(produced);
      } else {
        expect(Math.max(produced.width, produced.height), attributes).toBeLessThanOrEqual(
          LIMITS.image.logoMasterPx,
        );
      }
    }
  });

  it('turns a failure of the library into a code, and quotes nothing of the input', async () => {
    for (const text of [
      '',
      'not an svg',
      '<svg',
      '<svg xmlns="http://www.w3.org/2000/svg" M365HOSTILE-81-secret',
    ] as const) {
      let failure: unknown;
      try {
        await renderSvg(text, 512);
      } catch (caught) {
        failure = caught;
      }
      expect(failure, text).toBeInstanceOf(PipelineError);
      expect((failure as PipelineError).code, text).toBe('image_corrupt');
      expect((failure as Error).message, text).not.toContain('M365HOSTILE');
    }
  });
});

describe('renderSvg: no connection is made (H-04, H-05, H-08)', () => {
  it('opens no socket for the sanitised H-04, H-05 and H-08 files', async () => {
    const listener = await startLocalListener();
    for (const id of ['H-04', 'H-05', 'H-08'] as const) {
      for (const [label, bytes] of await rawInputs(id, listener.origin)) {
        const { svg } = rebuildSvg(bytes, { bound: 512 });
        await renderSvg(svg, 512);
        expect(listener.connections(), `${id} ${label}`).toBe(0);
      }
    }
  });

  it('opens no socket for the RAW hostile files either, which is what the sanitiser relies on in depth', async () => {
    const listener = await startLocalListener();
    const ids: readonly HostileId[] = ['H-04', 'H-05', 'H-06', 'H-08', 'H-09', 'H-13'];
    let rendered = 0;
    for (const id of ids) {
      for (const [label, bytes] of await rawInputs(id, listener.origin)) {
        try {
          await renderSvg(bytes, 512);
          rendered += 1;
        } catch (failure) {
          if (!(failure instanceof PipelineError)) throw failure;
        }
        expect(
          listener.connections(),
          `${id} ${label}: ${listener.requestLines().join(' | ')}`,
        ).toBe(0);
      }
    }
    // The listener only means something if the files really went into the renderer.
    expect(rendered).toBeGreaterThan(0);
  });

  it('the listener does count a connection, so zero means something (negative)', async () => {
    const listener = await startLocalListener();
    await fetch(`${listener.origin}/probe`).catch(() => undefined);
    expect(listener.connections()).toBeGreaterThan(0);
    expectGuardFails(
      () => {
        if (listener.connections() !== 0) throw new Error('the listener saw a connection');
      },
      undefined,
      { reason: 'saw a connection' },
    );
  });
});
