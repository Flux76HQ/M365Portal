// The boot data: the `me` and `branding` the server embeds in the HTML shell as
// `<script type="application/json" id="m365-boot" nonce="...">{"me": ..., "branding": ...}</script>`
// (contract C8, plan 9.2). Reading it means the first render needs no API round trip.
//
// The block comes from our own server, but it is still parsed with the shared schemas: a shell from
// an older or newer version, or a development server that renders none, must not crash the app. On
// anything wrong the reader answers null and the app fetches the two resources like any other query.
import { BrandingSchema, type Branding } from '@m365portal/shared/schemas/branding';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import type { z } from 'zod';

/** `GET /api/v1/me`. (schemas/meta.ts exports the schema; the type is derived here.) */
export type MeResponse = z.infer<typeof MeResponseSchema>;

export interface BootData {
  readonly me: MeResponse;
  readonly branding: Branding;
}

/** The id of the data block in the shell template. */
export const BOOT_DATA_ELEMENT_ID = 'm365-boot';

/** Reads and validates the data block. Null when it is absent, empty, not JSON or not the right shape. */
export function readBootData(doc: Document = document): BootData | null {
  const element = doc.getElementById(BOOT_DATA_ELEMENT_ID);
  const text = element?.textContent.trim();
  if (text === undefined || text === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;

  const me = MeResponseSchema.safeParse(candidate.me);
  const branding = BrandingSchema.safeParse(candidate.branding);
  return me.success && branding.success ? { me: me.data, branding: branding.data } : null;
}
