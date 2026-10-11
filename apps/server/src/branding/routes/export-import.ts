// The export and import routes (T-A-088; FR-A-093, FR-A-044; R10 and R11):
//
//   R10 GET  /api/v1/branding/export            `settings:branding`, rate class read, audit `branding.export`
//   R11 POST /api/v1/branding/import?dryRun=    `settings:branding`, rate class upload, audit `branding.import`
//
// R10 is a read that writes an audit row, so the route wrapper runs the `Sec-Fetch-Site` rule on it
// (a cross-site `<img>` or form cannot make the server write audit rows or build an export) and a
// denial of a read is not audited (PA-15). R11 reads its body as text and parses it itself: the
// duplicate, `__proto__` and depth rules need the text, which a parsed body no longer has. The body
// limit (9,437,184 bytes) is the wrapper's, applied while the body streams.
import type { RouteConfig } from '@hono/zod-openapi';
import { revisionEtag } from '@m365portal/shared/schemas/branding';
import {
  BrandingExportSchema,
  ImportQuerySchema,
  ImportResultSchema,
} from '@m365portal/shared/schemas/export-import';
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import { createBrandingTransfer, type BrandingTransferDeps } from '../export-import.js';
import { changeContextOf, ifMatchRevisionOf } from './request-support.js';

export type ExportImportRoutesDeps = BrandingTransferDeps;

/** `If-Match` is documented here and judged by the handler: the validator cannot answer 428. */
const IfMatchHeaders = z.object({ 'if-match': z.string().optional() });

/** The import body as OpenAPI documents it; not validated by the wrapper, parsed by the handler. */
type ZodRequestBody = NonNullable<NonNullable<RouteConfig['request']>['body']>;

const IMPORT_BODY: ZodRequestBody = {
  required: true,
  description:
    'A BrandingExport document. Read by a strict parser of its own: repeated, __proto__ and constructor keys, unknown keys and deep nesting are refused.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['schemaVersion', 'orgName', 'accent', 'images'],
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          orgName: { type: 'string' },
          accent: { type: 'string' },
          images: {
            type: 'object',
            required: ['logoLight', 'logoDark', 'compact'],
            additionalProperties: false,
            properties: {
              logoLight: { type: ['string', 'null'], contentEncoding: 'base64' },
              logoDark: { type: ['string', 'null'], contentEncoding: 'base64' },
              compact: { type: ['string', 'null'], contentEncoding: 'base64' },
            },
          },
        },
      },
    },
  },
};

export function exportImportRoutes(deps: ExportImportRoutesDeps): RouteDefinition[] {
  const transfer = createBrandingTransfer(deps);
  return [
    defineRoute({
      id: 'branding.export',
      method: 'GET',
      path: '/api/v1/branding/export',
      access: { permission: 'settings:branding' },
      rateLimit: 'read',
      audit: 'branding.export',
      summary: 'Export the branding',
      description:
        'The name, the accent and the stored master PNGs as base64 (the explicit compact logo only), as a downloadable JSON file. Audited as branding.export; refused for a cross-site request.',
      responses: {
        200: {
          description: 'The export document.',
          headers: {
            'Content-Disposition': {
              description: 'attachment with a dated file name',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: BrandingExportSchema } },
        },
      },
      handler: async (c) => {
        const { text, fileName } = await transfer.exportDocument(changeContextOf(c));
        return c.body(text, 200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Cache-Control': 'no-store',
        });
      },
    }),

    defineRoute({
      id: 'branding.import',
      method: 'POST',
      path: '/api/v1/branding/import',
      access: { permission: 'settings:branding' },
      rateLimit: 'upload',
      bodyLimit: 'import',
      audit: 'branding.import',
      summary: 'Import a branding',
      description:
        'Validates the document strictly, runs every image through the complete pipeline and applies everything in one transaction, or nothing. With dryRun=true it stores nothing and returns what would be applied. If-Match is required unless dryRun=true.',
      request: { query: ImportQuerySchema, headers: IfMatchHeaders, body: IMPORT_BODY },
      responses: {
        200: {
          description: 'The outcome of the import (or of the dry run).',
          content: { 'application/json': { schema: ImportResultSchema } },
        },
      },
      handler: async (c, input) => {
        const dryRun = input.query.dryRun === 'true';
        // The precondition first: a client that forgot it learns that before anything is read.
        const expectedRevision = dryRun ? null : ifMatchRevisionOf(c);
        const body = new Uint8Array(await c.req.arrayBuffer());
        const result = await transfer.importDocument({
          body,
          dryRun,
          expectedRevision,
          context: changeContextOf(c),
        });
        const headers: Record<string, string> =
          result.branding === null ? {} : { ETag: revisionEtag(result.branding.revision) };
        return c.json(result, 200, headers);
      },
    }),
  ];
}
