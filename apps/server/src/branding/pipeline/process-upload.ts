// The upload stages in one call (T-A-078 to T-A-081; plan 8.5 stages 6 to 8): sniff by content, then
// the raster path (PNG, JPEG) or the SVG path (pre-scan, strict parse, allowlist rebuild, rasterise),
// then the luminance of what was written. Pure with respect to its input: bytes in, bytes out; no
// file, no socket, no environment. It runs in the image child process (`image-worker.ts` hands it to
// `handleJob` as the `upload` stage) and in the in-process tests of the hostile corpus.
//
// A failure the input causes is a `PipelineError` with a problem code. A failure of the output
// self-check is an `OutputCheckError`. Anything else is a fault of ours and propagates unchanged.
import type { AssetSlot } from '@m365portal/shared/schemas/assets';
import type { UploadResult } from './job-handler.js';
import { decodeRgba, inspectVisibleInk } from './plate.js';
import { rasterise, slotBound, type RasterResult } from './raster.js';
import { sniffImage } from './sniff.js';
import { rebuildSvg } from './svg/rebuild.js';
import { renderSvg } from './svg/render.js';

async function rasteriseAnyKind(bytes: Uint8Array, slot: AssetSlot): Promise<RasterResult> {
  const kind = sniffImage(bytes);
  if (kind !== 'svg') return rasterise(bytes, kind, slot);
  // An SVG is rebuilt from the allowlist, rasterised and discarded; only the PNG goes on.
  const bound = slotBound(slot);
  const rebuilt = rebuildSvg(bytes, { bound });
  const output = await renderSvg(rebuilt.svg, bound);
  return { ...output, warnings: rebuilt.warnings };
}

export async function processUpload(input: {
  readonly bytes: Uint8Array;
  readonly slot: AssetSlot;
}): Promise<UploadResult> {
  const result = await rasteriseAnyKind(input.bytes, input.slot);
  const ink = inspectVisibleInk(await decodeRgba(result.png));
  return {
    png: result.png,
    width: result.width,
    height: result.height,
    luminance: ink.luminance,
    warnings: result.warnings,
  };
}
