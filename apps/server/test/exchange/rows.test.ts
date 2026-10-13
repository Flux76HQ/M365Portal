// T-D-113, FR-D-107: the rows the worker returns, read defensively. A property of the wrong type is
// `null`, a string is cut to 256 bytes (each item of a list as well), an empty string is `null`, an
// address loses `SMTP:`, a GUID must be one, a row without a GUID is dropped.
import { describe, expect, it } from 'vitest';
import {
  toDistributionGroup,
  toMailContact,
  toMember,
  toOrganizationConfig,
} from '../../src/integrations/exchange/pwsh/rows.js';

const GUID = '5A6B7C8D-1111-4222-8333-944455556666';

describe('toDistributionGroup', () => {
  const row = {
    Guid: GUID,
    ExternalDirectoryObjectId: null,
    DistinguishedName: 'CN=Marketing,OU=x',
    Name: 'Marketing',
    DisplayName: 'Marketing group',
    Alias: 'marketing',
    PrimarySmtpAddress: 'SMTP:marketing@contoso.example',
    RecipientTypeDetails: 'MailUniversalSecurityGroup',
    IsDirSynced: false,
    ManagedBy: ['Anna Jansen', 'Bob'],
    WhenCreatedUTC: '2026-01-02T03:04:05Z',
  };

  it('maps every property, with a lower-case GUID and the list kept item by item', () => {
    expect(toDistributionGroup(row)).toEqual({
      guid: GUID.toLowerCase(),
      externalDirectoryObjectId: null,
      distinguishedName: 'CN=Marketing,OU=x',
      name: 'Marketing',
      displayName: 'Marketing group',
      alias: 'marketing',
      primarySmtpAddress: 'marketing@contoso.example',
      recipientTypeDetails: 'MailUniversalSecurityGroup',
      kind: 'standard',
      securityEnabled: true,
      isDirSynced: false,
      managedBy: ['Anna Jansen', 'Bob'],
      createdDateTime: '2026-01-02T03:04:05Z',
      memberCount: null,
    });
  });

  it('decides the kind: synced beats dynamic beats standard; unknown is standard', () => {
    expect(toDistributionGroup({ ...row, IsDirSynced: true })?.kind).toBe('synced');
    expect(
      toDistributionGroup({
        ...row,
        RecipientTypeDetails: 'DynamicDistributionGroup',
        IsDirSynced: null,
      })?.kind,
    ).toBe('dynamic');
    expect(toDistributionGroup({ ...row, IsDirSynced: undefined })?.kind).toBe('standard');
    expect(toDistributionGroup({ ...row, IsDirSynced: 'yes' })?.isDirSynced).toBeNull();
  });

  it('knows a security group by its type and nothing else, and leaves unknown as null', () => {
    expect(
      toDistributionGroup({ ...row, RecipientTypeDetails: 'MailUniversalDistributionGroup' })
        ?.securityEnabled,
    ).toBe(false);
    expect(toDistributionGroup({ ...row, RecipientTypeDetails: null })?.securityEnabled).toBeNull();
  });

  it('uses the name when there is no display name, and drops a row without a GUID', () => {
    expect(toDistributionGroup({ ...row, DisplayName: '' })?.displayName).toBe('Marketing');
    expect(toDistributionGroup({ ...row, Guid: 'not-a-guid' })).toBeNull();
    expect(toDistributionGroup({ ...row, Guid: undefined })).toBeNull();
    expect(toDistributionGroup({ ...row, Guid: 7 })).toBeNull();
  });

  it('cuts each item of a list and each string to 256 bytes, and drops what is not a string', () => {
    const long = 'é'.repeat(300);
    const mapped = toDistributionGroup({ ...row, ManagedBy: [long, 5, null, 'ok'], Name: long });
    expect(new TextEncoder().encode(mapped?.managedBy?.[0] ?? '').length).toBeLessThanOrEqual(256);
    expect(mapped?.managedBy).toHaveLength(2);
    expect(mapped?.managedBy?.[1]).toBe('ok');
    expect(new TextEncoder().encode(mapped?.name ?? '').length).toBeLessThanOrEqual(256);
  });

  it('reads a list that is not a list, and a date that is not a date, as null', () => {
    const mapped = toDistributionGroup({ ...row, ManagedBy: 'Anna', WhenCreatedUTC: '2026-01-02' });
    expect(mapped?.managedBy).toBeNull();
    expect(mapped?.createdDateTime).toBeNull();
  });
});

describe('toMailContact', () => {
  it('strips SMTP: from the addresses, turns empty names into null and keeps the flags', () => {
    expect(
      toMailContact({
        Guid: GUID,
        ExternalEmailAddress: 'smtp:carol@partner.example',
        PrimarySmtpAddress: 'SMTP:carol@partner.example',
        Name: 'Carol',
        DisplayName: 'Carol Bakker',
        Alias: 'carol',
        FirstName: '',
        LastName: 'Bakker',
        HiddenFromAddressListsEnabled: true,
        IsDirSynced: false,
        WhenCreatedUTC: '2026-01-02T03:04:05Z',
      }),
    ).toMatchObject({
      guid: GUID.toLowerCase(),
      externalEmailAddress: 'carol@partner.example',
      primarySmtpAddress: 'carol@partner.example',
      firstName: null,
      lastName: 'Bakker',
      hiddenFromAddressListsEnabled: true,
      isDirSynced: false,
    });
  });

  it('is null for a row without a GUID', () => {
    expect(toMailContact({ Name: 'x' })).toBeNull();
  });
});

describe('toMember and toOrganizationConfig', () => {
  it('keeps the scalar properties of the Admin API and the Entra id, and nulls what is missing', () => {
    expect(
      toMember({
        Guid: GUID,
        Name: 'Anna',
        DisplayName: 'Anna Jansen',
        FirstName: '',
        HiddenFromAddressListsEnabled: false,
        ExternalDirectoryObjectId: GUID,
        PrimarySmtpAddress: 'SMTP:a@b.example',
        Extra: 'x',
      }),
    ).toMatchObject({
      guid: GUID.toLowerCase(),
      name: 'Anna',
      DisplayName: 'Anna Jansen',
      FirstName: null,
      LastName: null,
      HiddenFromAddressListsEnabled: false,
      ExternalDirectoryObjectId: GUID.toLowerCase(),
      PrimarySmtpAddress: 'a@b.example',
    });
    expect(toMember({ Name: 'x' })).toBeNull();
    expect('Extra' in (toMember({ Guid: GUID, Extra: 'x' }) ?? {})).toBe(false);
  });

  it('returns name and guid, and the other selected properties as scalars', () => {
    expect(
      toOrganizationConfig(
        {
          Name: 'contoso',
          Guid: GUID,
          MailTipsLargeAudienceThreshold: 25,
          MailTipsAllTipsEnabled: 'yes',
        },
        ['Name', 'MailTipsLargeAudienceThreshold', 'MailTipsAllTipsEnabled'],
      ),
    ).toEqual({
      name: 'contoso',
      guid: null,
      MailTipsLargeAudienceThreshold: 25,
      MailTipsAllTipsEnabled: 'yes',
    });
  });
});
