// The member rows of a distribution list (T-D-118, FR-D-202; the Phase C rule of FR-C-307, ADR 0179): the
// ONE function that turns a recipient of Exchange into a row of the wire, and so the one place that
// decides what an actor may learn of an object they met through a list.
//
//   a user      in full when the actor's `users:read` covers it (in full or `basic`: both give the id, the
//               name and the address, which is all the row has), otherwise a restricted row;
//   a contact   in full when `contacts:read` covers it, otherwise a restricted row;
//   a group     in full when `groups:read` covers it, otherwise a restricted row;
//   anything    a shared mailbox, a room: its kind and id, no name, when the actor may see users, contacts
//   else        or groups at all ("counted, not shown by name"); otherwise restricted.
//
// A restricted row is `{ kind, restricted: true }`: no id, no name, no address, not even a `null` id (the
// key would be a hint, `DistributionListRestrictedMemberSchema`). The function takes the capability
// values of the policy layer (`VisibleScope`), so a handler that never asked cannot call it. An
// attribute Exchange did not return never matches a scope item (fail closed): a member has no
// department in Exchange, so a department-scoped actor sees users as restricted rows.
import type {
  DistributionListMemberRow,
  DistributionListRestrictedMember,
} from '@m365portal/shared/schemas/distribution-lists';
import { contactResource } from './mappers.js';
import { groupResource, userResource } from '../directory/mappers.js';
import { seesNothing, visibilityOf } from '../directory/scoped-list.js';
import type { VisibleScope } from '../policy/index.js';
import type { ExchangeRecipient } from '../ports/exchange.js';
import {
  memberAddress,
  memberDisplayName,
  memberKindOf,
  memberWireId,
  recipientProperty,
} from './mappers.js';

/** What the actor may see of the three object types a member can be. */
export interface MemberVisibility {
  readonly users: VisibleScope<'user'>;
  readonly contacts: VisibleScope<'contact'>;
  readonly groups: VisibleScope<'group'>;
}

/** The row for an object the actor may not see: its kind and nothing else. */
export function restricted(
  kind: DistributionListMemberRow['kind'],
): DistributionListRestrictedMember {
  return { kind, restricted: true };
}

/** A row of the wire for a member, or `null` for a recipient that has no usable id (it cannot be addressed). */
export function toMemberRow(
  recipient: ExchangeRecipient,
  visibility: MemberVisibility,
): DistributionListMemberRow | null {
  const id = memberWireId(recipient);
  if (id === null) return null;
  const kind = memberKindOf(recipient);
  const displayName = memberDisplayName(recipient);
  const address = memberAddress(recipient);
  const full = { kind, id, displayName, primarySmtpAddress: address };

  switch (kind) {
    case 'user': {
      const seen = visibilityOf(
        visibility.users.scopes,
        userResource({ id, displayName, mail: address, department: null }),
      );
      return seen === null ? restricted('user') : full;
    }
    case 'contact': {
      const seen = visibilityOf(
        visibility.contacts.scopes,
        contactResource({
          guid: id,
          displayName,
          alias: recipientProperty(recipient, 'Alias'),
          externalEmailAddress: address,
          primarySmtpAddress: address,
        }),
      );
      return seen === null ? restricted('contact') : full;
    }
    case 'group': {
      const seen = visibilityOf(
        visibility.groups.scopes,
        groupResource({
          id,
          displayName,
          mailNickname: recipientProperty(recipient, 'Alias'),
          mail: address,
        }),
      );
      return seen === null ? restricted('group') : full;
    }
    case 'other': {
      const mayCount =
        !seesNothing(visibility.users.scopes) ||
        !seesNothing(visibility.contacts.scopes) ||
        !seesNothing(visibility.groups.scopes);
      if (!mayCount) return restricted('other');
      return { kind: 'other', id, displayName: null, primarySmtpAddress: null };
    }
  }
}
