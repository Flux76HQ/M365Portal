// SVG rasterisation (T-A-081; FR-A-088; PD-09; plan 8.5 stage 7b; R-06): the sanitised SVG becomes a PNG
// and is thrown away. An SVG is never stored or served; what the application keeps is the PNG that
// comes out of here, through the same encoder and the same self-check as every raster upload.
//
// The size is not decided here. `rebuildSvg` wrote explicit `width` and `height` on the root, computed
// from the view box and the slot's bound, so the library renders exactly that many pixels (at the
// library's default density of 72 a CSS pixel is a pixel). The size a file declares for itself never
// reaches the library when the input is a rebuilt document. When the input is a raw file (the tests
// feed the renderer one on purpose), the library's own pixel limit is the second layer: a declared
// size that would need more than 16,777,216 pixels is refused as `svg_too_complex`.
//
// What the library does with an SVG, and what is pinned by `svg-render.test.ts`: it loads no
// external reference (`<image href>`, `@import`, `file:` and `http:` are not fetched), runs no script
// and honours no event handler, so rendering makes no connection and reads no file even for a raw
// hostile file. The sanitiser removes all of it anyway; neither layer is trusted alone.
//
// Text cannot be drawn: the runtime image has no fonts (`<text>` is refused earlier, A-38). The
// question whether the prebuilt libvips of the distroless image contains the SVG loader at all (R-06)
// is answered by the image smoke test of `T-A-235`, which uploads an SVG into the running container.
//
// A fully transparent result (every shape `fill="none"`, a zero-opacity fill) has nothing to show and
// is `image_empty`.
import { LIMITS } from '@m365portal/shared/limits';
import sharp from 'sharp';
import { PipelineError } from '../errors.js';
import { decodeRgba, inspectVisibleInk } from '../plate.js';
import { classifyDecodeFailure, encodePng, type RasterOutput } from '../raster.js';

/** A failure of the library on an SVG: too many pixels is too complex, anything else is a file it cannot draw. */
function classifySvgFailure(failure: unknown): PipelineError {
  const decoded = classifyDecodeFailure(failure);
  return decoded.code === 'image_pixels_exceeded'
    ? new PipelineError('svg_too_complex', 'the SVG would need more pixels than the limit allows')
    : decoded;
}

/**
 * Rasterise a sanitised SVG into the PNG that is stored. `bound` is the largest edge the slot
 * allows; the output is never larger. Throws `PipelineError` (`svg_too_complex`, `image_corrupt`,
 * `image_empty`) or, for a failure of the output self-check, `OutputCheckError`.
 */
export async function renderSvg(svg: string | Uint8Array, bound: number): Promise<RasterOutput> {
  let image;
  try {
    const input = typeof svg === 'string' ? Buffer.from(svg, 'utf8') : Buffer.from(svg);
    image = sharp(input, { failOn: 'warning', limitInputPixels: LIMITS.image.inputPixels });
  } catch (failure) {
    throw classifySvgFailure(failure);
  }
  const output = await encodePng(image, bound, classifySvgFailure);
  const ink = inspectVisibleInk(await decodeRgba(output.png));
  if (ink.bounds === null) {
    throw new PipelineError('image_empty', 'the rendered SVG has nothing visible in it');
  }
  return output;
}
