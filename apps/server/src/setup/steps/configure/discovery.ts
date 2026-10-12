// Discovery and the adoption trust (T-B-132, FR-B-304, FR-B-318, EB-06, EB-36; plan 9.5).
//
// The order that makes a run idempotent and never creates a silent duplicate:
//   1. the stored application object id (`GET /applications/{id}`), if it still exists;
//   2. `GET /applications?$filter=displayName eq '<name>'&$select=id,appId,displayName,tags` (single
//      quotes in the name are doubled by the provisioner):
//        - exactly one match carrying our install tag: ours, adopted (it was created by this install,
//          for example by a run that died before its transaction);
//        - no tagged match and exactly one other: a candidate that is not ours; the trust inspection of
//          FR-B-318 runs and the operator is asked (`application_adoption_required`);
//        - several (two tagged, or no tagged and several): `application_ambiguous`;
//   3. nothing: the caller creates.
//
// Trust inspection, before a candidate that is not ours is even offered: the password credentials, key
// credentials and owners of the application and of its service principal are read. A password
// credential on either ends the step with `application_untrusted` (a secret the panel does not hold
// would carry every permission the wizard is about to grant). Key credentials or owners other than the
// bootstrap identity make the prompt require an acknowledgement. A count that cannot be read stops the
// step (fail closed, U50). Nothing is deleted from the candidate.
import type { ApplicationInfo, CredentialInventory, TenantProvisioner } from '../../../ports/provisioner.js';
import { SetupFailure } from '../../context.js';
import type { AdoptionPrompt } from '../../wire.js';

export type Discovery =
  | { readonly kind: 'stored'; readonly app: ApplicationInfo }
  | { readonly kind: 'ours'; readonly app: ApplicationInfo }
  | { readonly kind: 'foreign'; readonly app: ApplicationInfo; readonly prompt: AdoptionPrompt }
  | { readonly kind: 'none' };

export interface DiscoveryInput {
  readonly provisioner: TenantProvisioner;
  readonly storedObjectId: string | null;
  readonly displayName: string;
  readonly installTag: string;
  /** The `oid` of the bootstrap identity: an owner that is this person is not foreign. */
  readonly bootstrapOid: string | undefined;
}

const hasTag = (app: ApplicationInfo, tag: string): boolean => app.tags?.includes(tag) === true;

/** The counts of FR-B-318, or the failure. Never returns a count it could not read. */
export async function inspectCandidate(
  provisioner: TenantProvisioner,
  candidate: ApplicationInfo,
  bootstrapOid: string | undefined,
): Promise<AdoptionPrompt> {
  const app = await provisioner.inspectApplication(candidate.id);
  const sp = await provisioner.inspectServicePrincipal(candidate.appId);

  const unreadable = (inventory: CredentialInventory): boolean =>
    inventory.passwordCredentials === null ||
    inventory.keyCredentials === null ||
    inventory.ownerIds === null;
  if (unreadable(app) || (sp !== null && unreadable(sp))) {
    throw new SetupFailure('application_untrusted', { count: 0 });
  }
  const passwords = (app.passwordCredentials ?? 0) + (sp?.passwordCredentials ?? 0);
  if (passwords > 0) throw new SetupFailure('application_untrusted', { count: passwords });

  const foreignOwners = (inventory: CredentialInventory | null): number =>
    (inventory?.ownerIds ?? []).filter((id) => id.toLowerCase() !== bootstrapOid?.toLowerCase()).length;
  const foreign = {
    keyCredentials: app.keyCredentials?.length ?? 0,
    owners: foreignOwners(app),
    servicePrincipalKeyCredentials: sp?.keyCredentials?.length ?? 0,
    servicePrincipalOwners: foreignOwners(sp),
  };
  return {
    kind: 'application',
    candidate: {
      objectId: candidate.id,
      appId: candidate.appId,
      displayName: (candidate.displayName ?? '').slice(0, 256),
      foreign,
    },
    requiresAcknowledgement: Object.values(foreign).some((count) => count > 0),
  };
}

export async function discoverApplication(input: DiscoveryInput): Promise<Discovery> {
  const { provisioner } = input;
  if (input.storedObjectId !== null) {
    const stored = await provisioner.getApplication(input.storedObjectId);
    if (stored !== null) return { kind: 'stored', app: stored };
  }

  const matches = await provisioner.findApplicationsByDisplayName(input.displayName);
  const tagged = matches.filter((app) => hasTag(app, input.installTag));
  if (tagged.length > 1) throw new SetupFailure('application_ambiguous', { count: tagged.length });
  const [ours] = tagged;
  if (ours !== undefined) return { kind: 'ours', app: ours };

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) throw new SetupFailure('application_ambiguous', { count: matches.length });
  const [candidate] = matches;
  if (candidate === undefined) return { kind: 'none' };
  const prompt = await inspectCandidate(provisioner, candidate, input.bootstrapOid);
  return { kind: 'foreign', app: candidate, prompt };
}
