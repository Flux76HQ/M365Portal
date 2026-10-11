// The typed calls of the branding routes (T-A-210; FR-A-132, FR-A-083 client, FR-A-112; contract R6 to R11).
//
// Everything goes through the S4 API client (`lib/api.ts`), which owns the network, the CSRF token and the
// problem translation; this module only knows the paths, the verbs, the headers and the shapes.
//
// The Zod schemas of the wire are imported lazily (plan 9.3): the Appearance route chunk loads them on the
// first call, the entry chunk never does. `import type` is free; a value import of a schema from here
// would put Zod's schemas in whatever chunk reaches this file (`test/branding/api.test.ts` scans for it).
import { ApiError, getApiClient, type ApiClient } from '../../lib/api';
import type {
  ApplyBrandingRequest,
  AssetSlot,
  Branding,
  ImportResult,
  UploadAssetResponse,
} from './types';

export const BRANDING_PATH = '/api/v1/branding';
export const BRANDING_ASSETS_PATH = '/api/v1/branding/assets';
export const BRANDING_IMPORT_PATH = '/api/v1/branding/import';
/** The export is a plain link: the browser downloads it (`Content-Disposition: attachment`). */
export const BRANDING_EXPORT_PATH = '/api/v1/branding/export';

/** 412 `branding_conflict`: someone saved a newer revision since this page loaded. Still an `ApiError`. */
export class BrandingConflictError extends ApiError {
  constructor(source: ApiError) {
    super({
      code: source.code,
      status: source.status,
      requestId: source.requestId,
      errors: source.errors,
      expectedOrigin: source.expectedOrigin,
      retryAfterSeconds: source.retryAfterSeconds,
    });
    this.name = 'BrandingConflictError';
  }
}

export function isBrandingConflict(error: unknown): error is BrandingConflictError {
  return error instanceof BrandingConflictError;
}

/** The origin the panel expects, when the error is `origin_not_allowed` and the server named it. */
export function expectedOriginOf(error: unknown): string | null {
  return error instanceof ApiError && error.code === 'origin_not_allowed'
    ? error.expectedOrigin
    : null;
}

async function conflictAware<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.status === 412 && error.code === 'branding_conflict') {
      throw new BrandingConflictError(error);
    }
    throw error;
  }
}

export interface ImportOptions {
  readonly dryRun: boolean;
  /** Required unless `dryRun`. */
  readonly revision?: number;
  readonly signal?: AbortSignal;
}

export interface BrandingApi {
  readonly get: (signal?: AbortSignal) => Promise<Branding>;
  readonly stage: (
    slot: AssetSlot,
    file: Blob,
    signal?: AbortSignal,
  ) => Promise<UploadAssetResponse>;
  readonly apply: (request: ApplyBrandingRequest, revision: number) => Promise<Branding>;
  readonly reset: (revision: number) => Promise<Branding>;
  readonly importDocument: (text: string, options: ImportOptions) => Promise<ImportResult>;
}

const loadBrandingSchemas = () => import('@m365portal/shared/schemas/branding');
const loadAssetSchemas = () => import('@m365portal/shared/schemas/assets');
const loadImportSchemas = () => import('@m365portal/shared/schemas/export-import');

export function createBrandingApi(client: ApiClient = getApiClient()): BrandingApi {
  const ifMatch = async (revision: number): Promise<Record<string, string>> => {
    const { revisionEtag } = await loadBrandingSchemas();
    return { 'If-Match': revisionEtag(revision) };
  };

  return {
    async get(signal) {
      const { BrandingSchema } = await loadBrandingSchemas();
      return client.get(BRANDING_PATH, { ...(signal ? { signal } : {}), schema: BrandingSchema });
    },

    async stage(slot, file, signal) {
      const { UploadAssetResponseSchema } = await loadAssetSchemas();
      const form = new FormData();
      // The one part the route reads; the client's file name is never read by the server.
      form.append('file', file);
      return client.post(BRANDING_ASSETS_PATH, {
        body: form,
        query: { slot },
        ...(signal ? { signal } : {}),
        schema: UploadAssetResponseSchema,
      });
    },

    apply(request, revision) {
      return conflictAware(async () => {
        const { BrandingSchema } = await loadBrandingSchemas();
        return client.put(BRANDING_PATH, {
          body: request,
          headers: await ifMatch(revision),
          schema: BrandingSchema,
        });
      });
    },

    reset(revision) {
      return conflictAware(async () => {
        const { BrandingSchema } = await loadBrandingSchemas();
        return client.delete(BRANDING_PATH, {
          headers: await ifMatch(revision),
          schema: BrandingSchema,
        });
      });
    },

    importDocument(text, options) {
      return conflictAware(async () => {
        if (!options.dryRun && options.revision === undefined) {
          throw new TypeError('a real import needs the revision it was loaded at');
        }
        const { ImportResultSchema } = await loadImportSchemas();
        const headers =
          options.dryRun || options.revision === undefined ? {} : await ifMatch(options.revision);
        return client.post(BRANDING_IMPORT_PATH, {
          // The text as read, not a re-serialised object: the server sees duplicate keys.
          body: new Blob([text], { type: 'application/json' }),
          query: { dryRun: options.dryRun },
          headers,
          ...(options.signal ? { signal: options.signal } : {}),
          schema: ImportResultSchema,
        });
      });
    },
  };
}
