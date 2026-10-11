// Serving the branding files (T-A-089; FR-A-090, FR-A-096; R12; E-05, E-27; H-43):
//
//   R12 GET /branding/{file}   public for the assets the applied branding references;
//                              `settings:branding` for the others (staged, or retired within 24 hours)
//
// The name is looked up, never joined: it must match `^[0-9a-f]{64}\.png$`, and the registry must know
// the hash; only then does the asset store build a path, from the validated hash alone. A name that
// fails either test, a hash the registry does not know, an unreferenced asset asked for by an actor
// without `settings:branding`, and a file that is gone from the disk are all the same 404 `not_found`
// problem, so the answer tells nobody which hashes exist.
//
// The response headers that make an image inert come from two places. `Content-Type`, `ETag` and
// `Cache-Control` are set here; `X-Content-Type-Options: nosniff`, the strict policy
// (`default-src 'none'; frame-ancestors 'none'; sandbox`) and `Cross-Origin-Resource-Policy:
// same-origin` are the "other" profile of the security headers, which every image response leaves
// through whatever its handler did (a handler cannot weaken it).
import { ProblemError } from '../../http/problem.js';
import { brandingAssetCacheControl } from '../../http/cache-headers.js';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import { authorize } from '../../policy/index.js';
import { z } from 'zod';
import { type DatabaseHandle } from '../../db/index.js';
import { AssetFileMissingError, type AssetStore } from '../asset-store.js';
import { findAsset } from '../repository.js';

export interface AssetServingDeps {
  /** The open database, or a thrown 503 `storage_unavailable`. */
  readonly requireDatabase: () => DatabaseHandle;
  readonly assets: Pick<AssetStore, 'read'>;
}

/** The only names that are looked up (FR-A-090). */
const ASSET_FILE = /^([0-9a-f]{64})\.png$/;

const FileParams = z.object({ file: z.string() });

/** Does an `If-None-Match` header name this tag? Weak comparison, as RFC 9110 requires. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const strip = (tag: string): string => tag.trim().replace(/^W\//, '');
  return header.trim() === '*' || header.split(',').some((tag) => strip(tag) === strip(etag));
}

export function assetServingRoutes(deps: AssetServingDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'assets.serve',
      method: 'GET',
      path: '/branding/{file}',
      access: { public: true },
      rateLimit: 'read',
      summary: 'A branding image',
      description:
        'Serves a processed PNG by its SHA-256 name. Referenced assets are public and immutable; unreferenced ones are for settings:branding only. Anything else is 404.',
      request: { params: FileParams },
      responses: {
        200: {
          description: 'The PNG.',
          headers: {
            ETag: { description: 'The strong validator: the hash.', schema: { type: 'string' } },
          },
          content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
        },
        304: { description: 'The browser has this image.' },
      },
      handler: async (c, input) => {
        const matched = ASSET_FILE.exec(input.params.file);
        const hash = matched?.[1];
        if (hash === undefined) throw new ProblemError('not_found');

        const row = findAsset(deps.requireDatabase(), hash);
        if (row === undefined) throw new ProblemError('not_found');
        const referenced = row.unreferencedAt === null;
        if (!referenced && !authorize(c.get('actor'), 'settings:branding').allow) {
          throw new ProblemError('not_found');
        }

        let bytes: Buffer;
        try {
          bytes = await deps.assets.read(hash);
        } catch (error) {
          // A file that is gone is logged once at start (`branding_asset_missing`); the UI falls back
          // to the monogram, so here it is only a 404.
          if (error instanceof AssetFileMissingError) throw new ProblemError('not_found');
          throw error;
        }

        const etag = `"${hash}"`;
        const headers = {
          ETag: etag,
          'Cache-Control': brandingAssetCacheControl(referenced),
        };
        if (matches(c.req.header('if-none-match'), etag)) {
          return new Response(null, { status: 304, headers });
        }
        return c.body(new Uint8Array(bytes), 200, {
          ...headers,
          'Content-Type': 'image/png',
          'Content-Length': String(bytes.length),
        });
      },
    }),
  ];
}
