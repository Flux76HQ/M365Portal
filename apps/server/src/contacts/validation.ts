// What the contact writes decide before and around the call to Exchange (T-D-121, FR-D-302, EC-D9, U95).
//
// The shape of every field is the schema's business (`@m365portal/shared/schemas/contacts`: display name,
// alias, normalised address, names). Left here are the two things a schema cannot know:
//
//   - the Exchange `-Name` of a new contact. It is unique and at most 64 characters (R-D-09), and a
//     person never types it (U95): it is the alias cut to 57 characters, a hyphen and six random
//     hexadecimal characters, so two contacts with the same alias never collide on the name;
//   - whether a duplicate exists: another contact with the same external address or alias. Exchange says
//     `already_exists` without saying which, and a pre-check lets the form show the field. The answer is
//     the pointer of the field, never the id of the other contact (a problem body has no member for an id,
//     and the other contact may be one the actor may not see).
import { LIMITS } from '@m365portal/shared/limits';
import type { RandomSource } from '../ports/clock.js';
import { ExchangeUnsupportedError } from '../ports/errors.js';
import type { ExchangeClient } from '../ports/exchange.js';

const SUFFIX_BYTES = 3;
const SUFFIX_CHARS = SUFFIX_BYTES * 2;

/** The Exchange name of a new contact: the alias, cut so that name, hyphen and suffix are 64 characters at most. */
export function deriveContactName(alias: string, random: RandomSource): string {
  const room = LIMITS.contacts.nameMaxChars - 1 - SUFFIX_CHARS;
  const suffix = Array.from(random.bytes(SUFFIX_BYTES), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${Array.from(alias).slice(0, room).join('')}-${suffix}`;
}

export type ConflictPointer = '/externalEmailAddress' | '/alias';

const lower = (value: string | null): string | null =>
  value === null ? null : value.toLowerCase();

/**
 * Which field collides with another contact? The address is asked first, as the form does. A prefix that
 * holds a wildcard cannot be searched (the allow-list refuses it) and is left to Exchange's own answer.
 */
export async function findContactConflict(
  exchange: ExchangeClient,
  fields: { readonly address?: string; readonly alias?: string },
  exceptGuid?: string,
): Promise<ConflictPointer | null> {
  const others = (guid: string): boolean => guid !== exceptGuid;
  try {
    if (fields.address !== undefined) {
      const found = await exchange.listMailContacts({ prefix: fields.address, limit: 100 });
      if (
        found.items.some(
          (contact) =>
            others(contact.guid) &&
            (lower(contact.externalEmailAddress) === fields.address ||
              lower(contact.primarySmtpAddress) === fields.address),
        )
      ) {
        return '/externalEmailAddress';
      }
    }
    if (fields.alias !== undefined) {
      const wanted = fields.alias.toLowerCase();
      const found = await exchange.listMailContacts({ prefix: fields.alias, limit: 100 });
      if (found.items.some((contact) => others(contact.guid) && lower(contact.alias) === wanted)) {
        return '/alias';
      }
    }
  } catch (error) {
    if (error instanceof ExchangeUnsupportedError) return null;
    throw error;
  }
  return null;
}
