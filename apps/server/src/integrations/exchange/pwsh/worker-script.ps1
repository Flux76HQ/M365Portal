# The Exchange worker (Phase D, T-D-112, T-D-114; FR-D-102 to FR-D-104, FR-D-107; plan 5.1).
#
# One long-lived PowerShell 7 process, started by the server with a fixed command line:
#   pwsh -NoLogo -NoProfile -NonInteractive -File worker-script.ps1 -CertificateMode memory|tmpfs
#        [-ScratchDirectory <dir>]
# It reads one JSON object per line on stdin and writes one JSON object per line on stdout. The
# protocol is packages/shared/src/exchange/protocol.ts: `ping`, `connect`, `call`, `shutdown`; an
# answer is `{ v, id, ok, data }` or `{ v, id, ok: false, error: { code[, retryAfterMs] } }`. The
# worker NEVER sends free text: a message from Exchange can hold a name or an address (FR-D-107), so
# every failure becomes a code of a closed list. Requests are served one at a time.
#
# What it may run: the ten cmdlets of the allow-list below, nothing else. The table is generated from
# packages/shared/src/exchange/allow-list.ts (the server validates against the same table before it
# writes a line) and carries its SHA-256; the worker reports both hashes when it connects, and the
# server stops a worker whose hashes differ from its own. The worker checks every call against the
# table again: a second line of defence, not the first.
#
# The certificate arrives in the `connect` message, on stdin, and never in an argument or the
# environment, as PEM text: the certificate and an unencrypted PKCS#8 key (GD1-0, amendment 1).
# `memory` (the default) builds an X509Certificate2 with X509Certificate2.CreateFromPem, so nothing
# is written to disk, and hands it to Connect-ExchangeOnline -Certificate (U75: UNVERIFIED on Linux).
# `tmpfs` is the fallback if U75 is false: the PEMs go to files with mode 0600 in a directory the
# server made on a tmpfs, a PKCS#12 file is derived from them (random password, mode 0600) for
# -CertificateFilePath, and all files are removed in a `finally` block, right after the connect.
#
# Nothing here prints for a person: no Write-Host, no Write-Error, no verbose output. Everything a
# cmdlet writes to a stream other than success is discarded.
[CmdletBinding()]
param(
    [ValidateSet('memory', 'tmpfs')]
    [string] $CertificateMode = 'memory',
    [string] $ScratchDirectory = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

# >>> GENERATED (allow-list and projections): apps/server/scripts/generate-exchange-worker.ts, do not edit by hand >>>
$script:AllowListJson = '{"cmdlets":{"Get-DistributionGroup":{"access":"read","atLeastOneOf":[],"confirmFalse":false,"params":{"Filter":{"kind":"text","maxChars":1024,"pattern":"plain"},"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"IncludeManagedByWithDisplayNames":{"kind":"switch"},"RecipientTypeDetails":{"kind":"identifierList","maxItems":4},"ResultSize":{"kind":"resultSize","maxInt":10000000},"SortBy":{"kind":"text","maxChars":64,"pattern":"identifier"}},"required":[]},"Get-DistributionGroupMember":{"access":"read","atLeastOneOf":[],"confirmFalse":false,"params":{"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"ResultSize":{"kind":"resultSize","maxInt":10000000}},"required":["Identity"]},"Add-DistributionGroupMember":{"access":"write","atLeastOneOf":[],"confirmFalse":false,"params":{"BypassSecurityGroupManagerCheck":{"kind":"switch"},"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"Member":{"kind":"text","maxChars":256,"pattern":"plain"}},"required":["Identity","Member"]},"Remove-DistributionGroupMember":{"access":"write","atLeastOneOf":[],"confirmFalse":true,"params":{"BypassSecurityGroupManagerCheck":{"kind":"switch"},"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"Member":{"kind":"text","maxChars":256,"pattern":"plain"}},"required":["Identity","Member"]},"Get-MailContact":{"access":"read","atLeastOneOf":[],"confirmFalse":false,"params":{"ANR":{"kind":"text","maxChars":256,"pattern":"plain"},"Filter":{"kind":"text","maxChars":1024,"pattern":"plain"},"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"RecipientTypeDetails":{"kind":"enumList","maxItems":2,"values":["MailContact","MailForestContact"]},"ResultSize":{"kind":"resultSize","maxInt":10000000},"SortBy":{"kind":"enum","values":["Name","DisplayName","Alias"]}},"required":[]},"New-MailContact":{"access":"write","atLeastOneOf":[],"confirmFalse":false,"params":{"Alias":{"kind":"text","maxChars":64,"pattern":"alias"},"DisplayName":{"kind":"text","maxChars":256,"pattern":"plain"},"ExternalEmailAddress":{"kind":"text","maxChars":254,"pattern":"smtp"},"FirstName":{"kind":"text","maxChars":64,"pattern":"plain"},"LastName":{"kind":"text","maxChars":64,"pattern":"plain"},"Name":{"kind":"text","maxChars":64,"pattern":"plain"}},"required":["Name","ExternalEmailAddress"]},"Set-MailContact":{"access":"write","atLeastOneOf":["Name","ExternalEmailAddress","Alias","DisplayName","HiddenFromAddressListsEnabled"],"confirmFalse":false,"params":{"Alias":{"kind":"text","maxChars":64,"pattern":"alias"},"DisplayName":{"kind":"text","maxChars":256,"pattern":"plain"},"ExternalEmailAddress":{"kind":"text","maxChars":254,"pattern":"smtp"},"HiddenFromAddressListsEnabled":{"kind":"boolean"},"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"Name":{"kind":"text","maxChars":64,"pattern":"plain"}},"required":["Identity"]},"Remove-MailContact":{"access":"write","atLeastOneOf":[],"confirmFalse":true,"params":{"Identity":{"kind":"text","maxChars":256,"pattern":"plain"}},"required":["Identity"]},"Get-Recipient":{"access":"read","atLeastOneOf":[],"confirmFalse":false,"params":{"Filter":{"kind":"text","maxChars":1024,"pattern":"plain"},"Identity":{"kind":"text","maxChars":256,"pattern":"plain"},"RecipientTypeDetails":{"kind":"identifierList","maxItems":8},"ResultSize":{"kind":"resultSize","maxInt":10000000}},"required":[]},"Get-OrganizationConfig":{"access":"read","atLeastOneOf":[],"confirmFalse":false,"params":{},"required":[]}},"patterns":{"alias":"^[A-Za-z0-9!#%*+\\-/=?^_~¡-ÿ]+(\\.[A-Za-z0-9!#%*+\\-/=?^_~¡-ÿ]+)*$","identifier":"^[A-Za-z][A-Za-z0-9]{0,63}$","plain":"^(?=.*\\S)[^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]+$","smtp":"^[a-z0-9!#%*+\\-/=?^_~]+(\\.[a-z0-9!#%*+\\-/=?^_~]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$"},"version":1}'
$script:AllowListSha256 = 'e7a0d270586c659a2d116eb33ce366da145b674d6f80088263375abbe79d8c02'
$script:ProjectionJson = '{"projections":{"Get-DistributionGroup":["Guid","ExternalDirectoryObjectId","DistinguishedName","Name","DisplayName","Alias","PrimarySmtpAddress","RecipientTypeDetails","IsDirSynced","ManagedBy","WhenCreatedUTC"],"Get-DistributionGroupMember":["Guid","ExternalDirectoryObjectId","Identity","Name","DisplayName","Alias","PrimarySmtpAddress","FirstName","LastName","RecipientType","RecipientTypeDetails","HiddenFromAddressListsEnabled"],"Get-MailContact":["Guid","ExternalDirectoryObjectId","DistinguishedName","Name","DisplayName","Alias","PrimarySmtpAddress","ExternalEmailAddress","FirstName","LastName","HiddenFromAddressListsEnabled","IsDirSynced","WhenCreatedUTC"],"Get-Recipient":["Guid","ExternalDirectoryObjectId","DistinguishedName","Name","DisplayName","Alias","PrimarySmtpAddress","RecipientType","RecipientTypeDetails","IsDirSynced","WhenCreatedUTC"],"Get-OrganizationConfig":["Name","Identity","Id","Guid","MailTipsAllTipsEnabled","MailTipsExternalRecipientsTipsEnabled","MailTipsLargeAudienceThreshold"]},"result":{"Get-DistributionGroup":"Get-DistributionGroup","Get-DistributionGroupMember":"Get-DistributionGroupMember","Add-DistributionGroupMember":null,"Remove-DistributionGroupMember":null,"Get-MailContact":"Get-MailContact","New-MailContact":"Get-MailContact","Set-MailContact":null,"Remove-MailContact":null,"Get-Recipient":"Get-Recipient","Get-OrganizationConfig":"Get-OrganizationConfig"},"version":1}'
$script:ProjectionSha256 = 'f7e75ec9e0fbc836d68550ff5ea52b687c88adede89e7f7667286eae53b55b3d'
# <<< END GENERATED <<<

$script:ProtocolVersion = 1
$script:LineMaxBytes = 1048576
$script:RequestIdPattern = '^[A-Za-z0-9-]{8,64}\z'
$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
$script:AllowList = ConvertFrom-Json -InputObject $script:AllowListJson -AsHashtable
$script:Projection = ConvertFrom-Json -InputObject $script:ProjectionJson -AsHashtable
$script:Connected = $false
$script:Certificate = $null
$script:ModuleVersion = $null

[Console]::InputEncoding = $script:Utf8
[Console]::OutputEncoding = $script:Utf8

# The protocol owns the real stdout. Anything else that writes to the console, in this script or inside
# a module (the Exchange module prints "Error Acquiring Token" with the tenant name and the error text
# to the console, measured with module 3.10.1), goes to a writer that discards it (FR-D-107).
$script:ProtocolOut = [Console]::Out
[Console]::SetOut([System.IO.TextWriter]::Null)
[Console]::SetError([System.IO.TextWriter]::Null)

# ------------------------------------------------------------------------------------------------
# Output: the only way anything leaves this process
# ------------------------------------------------------------------------------------------------

function Send-Line {
    param([System.Collections.IDictionary] $Message)
    $json = ConvertTo-Json -InputObject $Message -Depth 8 -Compress
    $script:ProtocolOut.WriteLine($json)
    $script:ProtocolOut.Flush()
}

function Send-Ok {
    param([string] $Id, $Data)
    Send-Line ([ordered]@{ v = $script:ProtocolVersion; id = $Id; ok = $true; data = $Data })
}

function Send-Failure {
    param([string] $Id, [string] $Code, [int] $RetryAfterMs = -1, [int] $Aadsts = 0, $Record = $null)
    $failure = [ordered]@{ code = $Code }
    if ($RetryAfterMs -ge 0) { $failure['retryAfterMs'] = $RetryAfterMs }
    # GD1-0 Amendment 2: the NUMBER of an Entra AADSTS code (digits only), never the text around it.
    if ($Aadsts -gt 0) { $failure['aadsts'] = $Aadsts }
    # GD1-0 Amendment 3: type name and error id only, filtered to [A-Za-z0-9_.]; never message text.
    if ($null -ne $Record) {
        $detail = [ordered]@{}
        try {
            $inner = $Record.Exception
            $depth = 0
            while ($null -ne $inner -and $null -ne $inner.InnerException -and $depth -lt 6) { $inner = $inner.InnerException; $depth++ }
            if ($null -ne $inner) {
                $type = [string] $inner.GetType().FullName
                if ($type -match '^[A-Za-z0-9_.]{1,120}$') { $detail['type'] = $type }
            }
            $errorId = ([string] $Record.FullyQualifiedErrorId).Split(',')[0]
            if ($errorId -match '^[A-Za-z0-9_.]{1,120}$') { $detail['errorId'] = $errorId }
        } catch { $null = $_ }
        if ($detail.Count -gt 0) { $failure['detail'] = $detail }
    }
    Send-Line ([ordered]@{ v = $script:ProtocolVersion; id = $Id; ok = $false; error = $failure })
}

# ------------------------------------------------------------------------------------------------
# From an error to a code of the closed list. The text of the error is read here and nowhere else,
# and is never sent. Patterns are English; an error that matches none is `internal`.
# UNVERIFIED on a real tenant (OV-D1, OV-D2): the wording of Exchange's messages.
# ------------------------------------------------------------------------------------------------

function Get-RetryAfterMs {
    param([string] $Text)
    $match = [regex]::Match($Text, '(?i)(?:retry|try again)[^0-9]{0,40}(\d{1,5})\s*(second|minute)')
    if (-not $match.Success) { return -1 }
    $value = [int] $match.Groups[1].Value
    if ($match.Groups[2].Value.ToLowerInvariant() -eq 'minute') { $value = $value * 60 }
    return [Math]::Min($value * 1000, 3600000)
}

function Get-ErrorCode {
    param([System.Management.Automation.ErrorRecord] $Record)
    $type = ''
    $text = ''
    if ($null -ne $Record.Exception) {
        $type = $Record.Exception.GetType().FullName
        $text = [string] $Record.Exception.Message
    }
    $id = [string] $Record.FullyQualifiedErrorId
    $all = "$type $id $text"

    if ($all -match '(?i)synchroniz[ei]d? from your on-premises|being synchronized') { return 'read_only_object' }
    if ($all -match '(?i)manager of the group|only be performed by a manager|not a manager') { return 'manager_check' }
    if ($all -match '(?i)is already a member|MemberAlreadyExists|already a member of the group') { return 'already_member' }
    if ($all -match "(?i)isn't a member|is not a member|MemberNotFound|not a member of the group") { return 'not_a_member' }
    if ($all -match "(?i)isn't a supported member|not a supported member|isn't supported as a member|unsupported member") { return 'member_type_not_allowed' }
    if ($all -match '(?i)throttl|too many requests|429|rate limit') { return 'throttled' }
    if ($all -match '(?i)already exists|already being used|is already in use|ManagementObjectAlreadyExists|proxy address .* already') { return 'already_exists' }
    if ($all -match "(?i)couldn't be found|could not be found|was not found|ManagementObjectNotFound|ObjectNotFound|RecipientNotFound") { return 'not_found' }
    if ($all -match '(?i)is not recognized as the name of a cmdlet|CommandNotFoundException') { return 'role_pending' }
    if ($all -match '(?i)timed out|TaskCanceledException|TimeoutException|operation was canceled') { return 'timeout' }
    if ($all -match '(?i)access is denied|insufficient (access|permission|privilege)|not (assigned|authorized)|unauthorized|forbidden|AADSTS|authentication failed|isn.t assigned to any management roles') { return 'permission_denied' }
    if ($all -match '(?i)ParameterBindingException|ValidationMetadataException|cannot validate argument|parameter cannot be found|cannot bind') { return 'invalid_argument' }
    return 'internal'
}

# The text of an error and of everything inside it, for matching only (never sent).
function Get-ExceptionText {
    param([System.Management.Automation.ErrorRecord] $Record)
    $parts = [System.Collections.Generic.List[string]]::new()
    $exception = $Record.Exception
    $depth = 0
    while ($null -ne $exception -and $depth -lt 6) {
        $parts.Add($exception.GetType().FullName)
        $parts.Add([string] $exception.Message)
        $exception = $exception.InnerException
        $depth++
    }
    $parts.Add([string] $Record.FullyQualifiedErrorId)
    return ($parts -join ' ')
}

# The AADSTS number of a refusal by the sign-in service, or 0. The module's own message starts with a fixed
# sentence that names AADSTS70011 whatever went wrong ("Case when Message contains:AADSTS70011 ..."): skipped.
function Get-AadstsNumber {
    param([string] $Text)
    $match = [regex]::Match($Text, '(?<!contains:)AADSTS(\d{1,7})(?!\d)')
    if (-not $match.Success) { return 0 }
    return [int] $match.Groups[1].Value
}

# A connect that fails. Narrower than Get-ErrorCode on purpose: the English text of a sign-in refusal
# ("Application ... was not found in the directory") must not read as a missing mailbox or contact.
function Send-ConnectFailure {
    param([string] $Id, [System.Management.Automation.ErrorRecord] $Record)
    $aadsts = Get-AadstsNumber (Get-ExceptionText $Record)
    if ($aadsts -gt 0) { Send-Failure -Id $Id -Code 'permission_denied' -Aadsts $aadsts -Record $Record; return }
    $code = Get-ErrorCode $Record
    if (@('throttled', 'timeout', 'role_pending', 'permission_denied', 'invalid_argument') -notcontains $code) { $code = 'internal' }
    $retry = -1
    if ($code -eq 'throttled' -and $null -ne $Record.Exception) { $retry = Get-RetryAfterMs ([string] $Record.Exception.Message) }
    Send-Failure -Id $Id -Code $code -RetryAfterMs $retry -Record $Record
}

function Send-ErrorRecord {
    param([string] $Id, [System.Management.Automation.ErrorRecord] $Record)
    $code = Get-ErrorCode $Record
    $retry = -1
    if ($code -eq 'throttled' -and $null -ne $Record.Exception) { $retry = Get-RetryAfterMs ([string] $Record.Exception.Message) }
    Send-Failure -Id $Id -Code $code -RetryAfterMs $retry -Record $Record
}

# ------------------------------------------------------------------------------------------------
# The allow-list: the same rules as packages/shared/src/exchange/allow-list.ts, read from the
# generated table. A call that breaks one is `invalid_argument`.
# ------------------------------------------------------------------------------------------------

function Test-TextValue {
    param($Value, $Spec)
    if ($Value -isnot [string]) { return $false }
    if ($Value.Length -gt [int] $Spec.maxChars) { return $false }
    $pattern = [string] $script:AllowList.patterns[[string] $Spec.pattern]
    if (-not $pattern.EndsWith('$')) { return $false }
    # .NET lets `$` match before a final line break; `\z` does not, as in the TypeScript side.
    $strict = $pattern.Substring(0, $pattern.Length - 1) + '\z'
    return [regex]::IsMatch($Value, $strict)
}

function Test-ParamValue {
    param($Value, $Spec)
    switch ([string] $Spec.kind) {
        'text' { return (Test-TextValue $Value $Spec) }
        'switch' { return ($Value -is [bool] -and $Value -eq $true) }
        'boolean' { return ($Value -is [bool]) }
        'resultSize' {
            if ($Value -is [string]) { return $Value -ceq 'Unlimited' }
            if ($Value -is [int] -or $Value -is [long]) { return ($Value -ge 1 -and $Value -le [long] $Spec.maxInt) }
            return $false
        }
        'enum' { return ($Value -is [string] -and @($Spec.values) -ccontains $Value) }
        'enumList' {
            if ($Value -isnot [System.Collections.IList]) { return $false }
            $items = @($Value)
            if ($items.Count -lt 1 -or $items.Count -gt [int] $Spec.maxItems) { return $false }
            foreach ($item in $items) { if ($item -isnot [string] -or @($Spec.values) -cnotcontains $item) { return $false } }
            return (@($items | Sort-Object -Unique).Count -eq $items.Count)
        }
        'identifierList' {
            if ($Value -isnot [System.Collections.IList]) { return $false }
            $items = @($Value)
            if ($items.Count -lt 1 -or $items.Count -gt [int] $Spec.maxItems) { return $false }
            $identifier = [string] $script:AllowList.patterns['identifier']
            $strict = $identifier.Substring(0, $identifier.Length - 1) + '\z'
            foreach ($item in $items) { if ($item -isnot [string] -or -not [regex]::IsMatch($item, $strict)) { return $false } }
            return $true
        }
        default { return $false }
    }
}

function Assert-AllowedCall {
    param([string] $Name, $Arguments)
    if (-not $script:AllowList.cmdlets.Contains($Name)) { throw 'not_allowed' }
    $spec = $script:AllowList.cmdlets[$Name]
    if ($Arguments -isnot [System.Collections.IDictionary]) { throw 'not_allowed' }
    foreach ($key in @($Arguments.Keys)) {
        if (-not $spec.params.Contains([string] $key)) { throw 'not_allowed' }
        if ($null -eq $Arguments[$key]) { throw 'not_allowed' }
        if (-not (Test-ParamValue $Arguments[$key] $spec.params[[string] $key])) { throw 'not_allowed' }
    }
    foreach ($required in @($spec.required)) {
        if (-not $Arguments.Contains([string] $required)) { throw 'not_allowed' }
    }
    $oneOf = @($spec.atLeastOneOf)
    if ($oneOf.Count -gt 0) {
        $present = @($oneOf | Where-Object { $Arguments.Contains([string] $_) })
        if ($present.Count -eq 0) { throw 'not_allowed' }
    }
}

# ------------------------------------------------------------------------------------------------
# Results: rows with the projected properties only
# ------------------------------------------------------------------------------------------------

function ConvertTo-PlainValue {
    param($Value, [string] $Name)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        if (($Name -eq 'ExternalEmailAddress' -or $Name -eq 'PrimarySmtpAddress') -and $Value -match '^(?i)smtp:') { return $Value.Substring(5) }
        return $Value
    }
    if ($Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return $Value }
    if ($Value -is [guid]) { return $Value.ToString('D').ToLowerInvariant() }
    if ($Value -is [datetime]) {
        # Exchange's WhenCreatedUTC has no kind: it is UTC, not local time.
        $utc = if ($Value.Kind -eq [System.DateTimeKind]::Unspecified) { [datetime]::SpecifyKind($Value, [System.DateTimeKind]::Utc) } else { $Value.ToUniversalTime() }
        return $utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $Value) { if ($null -ne $item) { $items.Add((ConvertTo-PlainValue $item $Name)) } }
        return , $items.ToArray()
    }
    $text = $Value.ToString()
    if (($Name -eq 'ExternalEmailAddress' -or $Name -eq 'PrimarySmtpAddress') -and $text -match '^(?i)smtp:') { return $text.Substring(5) }
    return $text
}

function ConvertTo-Row {
    param($Object, $Names)
    $row = [ordered]@{}
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[[string] $name]
        if ($null -eq $property) { $row[[string] $name] = $null }
        else { $row[[string] $name] = ConvertTo-PlainValue $property.Value ([string] $name) }
    }
    return $row
}

function Get-ResultData {
    param([string] $Name, $Result)
    $key = $script:Projection.result[$Name]
    if ($null -eq $key) { return [ordered]@{ done = $true } }
    $names = @($script:Projection.projections[[string] $key])
    $budget = $script:LineMaxBytes - 4096
    $used = 0
    $rows = [System.Collections.Generic.List[object]]::new()
    $truncated = $false
    foreach ($object in @($Result)) {
        if ($null -eq $object) { continue }
        $row = ConvertTo-Row $object $names
        $size = $script:Utf8.GetByteCount((ConvertTo-Json -InputObject $row -Depth 4 -Compress)) + 1
        if ($used + $size -gt $budget) { $truncated = $true; break }
        $used += $size
        $rows.Add($row)
    }
    return [ordered]@{ rows = $rows.ToArray(); truncated = $truncated }
}

# ------------------------------------------------------------------------------------------------
# Connecting
# ------------------------------------------------------------------------------------------------

function Get-CommandNames {
    return @($script:AllowList.cmdlets.Keys | ForEach-Object { [string] $_ })
}

function Import-ExchangeModule {
    Import-Module -Name ExchangeOnlineManagement -ErrorAction Stop | Out-Null
    $loaded = Get-Module -Name ExchangeOnlineManagement | Sort-Object -Property Version -Descending | Select-Object -First 1
    $script:ModuleVersion = if ($null -eq $loaded) { $null } else { $loaded.Version.ToString() }
}

function New-PemCertificate {
    param([string] $CertificatePem, [string] $PrivateKeyPem)
    # .NET 5 and later (PowerShell 7.6 runs on .NET 9 or later): the certificate and the PKCS#8 key from
    # their PEM text, in memory. U75 (UNVERIFIED on Linux, OV-D1): that Connect-ExchangeOnline accepts it.
    return [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($CertificatePem, $PrivateKeyPem)
}

function Connect-InMemory {
    param([string] $AppId, [string] $Organization, [string] $CertificatePem, [string] $PrivateKeyPem)
    # The certificate is kept for the life of the process: the module renews its token with it.
    $script:Certificate = New-PemCertificate $CertificatePem $PrivateKeyPem
    Connect-ExchangeOnline -AppId $AppId -Organization $Organization -Certificate $script:Certificate `
        -CommandName (Get-CommandNames) -SkipLoadingFormatData -ShowBanner:$false -ErrorAction Stop 6>$null 5>$null 4>$null 3>$null | Out-Null
}

function Write-PrivateFile {
    param([string] $Path, [byte[]] $Bytes)
    $options = [System.IO.FileStreamOptions]::new()
    $options.Mode = [System.IO.FileMode]::CreateNew
    $options.Access = [System.IO.FileAccess]::Write
    $options.UnixCreateMode = [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite
    $stream = [System.IO.FileStream]::new($Path, $options)
    try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
}

function Connect-WithTmpfsFile {
    param([string] $AppId, [string] $Organization, [string] $CertificatePem, [string] $PrivateKeyPem)
    if ([string]::IsNullOrEmpty($ScratchDirectory) -or -not (Test-Path -LiteralPath $ScratchDirectory -PathType Container)) { throw 'no_scratch' }
    # The fallback of U75: the cmdlet reads a PKCS#12 FILE. The PEMs go to files (mode 0600), the
    # certificate object is built from them, and the PKCS#12 is derived from it with a random password
    # that exists only in this function. Every file is removed in the `finally` block, right after the connect.
    $token = [guid]::NewGuid().ToString('N')
    $certificatePath = Join-Path $ScratchDirectory ('c' + $token + '.pem')
    $keyPath = Join-Path $ScratchDirectory ('k' + $token + '.pem')
    $pfxPath = Join-Path $ScratchDirectory ('p' + $token + '.pfx')
    $pfxBytes = $null
    try {
        Write-PrivateFile $certificatePath ($script:Utf8.GetBytes($CertificatePem))
        Write-PrivateFile $keyPath ($script:Utf8.GetBytes($PrivateKeyPem))
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($certificatePath, $keyPath)
        $password = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
        $pfxBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
        $certificate.Dispose()
        Write-PrivateFile $pfxPath $pfxBytes
        $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
        Connect-ExchangeOnline -AppId $AppId -Organization $Organization -CertificateFilePath $pfxPath -CertificatePassword $secure `
            -CommandName (Get-CommandNames) -SkipLoadingFormatData -ShowBanner:$false -ErrorAction Stop 6>$null 5>$null 4>$null 3>$null | Out-Null
    } finally {
        if ($null -ne $pfxBytes) { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length) }
        Remove-Item -LiteralPath $certificatePath, $keyPath, $pfxPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-Hello {
    return [ordered]@{
        allowListSha256 = $script:AllowListSha256
        projectionSha256 = $script:ProjectionSha256
        moduleVersion = $script:ModuleVersion
        psVersion = $PSVersionTable.PSVersion.ToString()
        mode = $CertificateMode
        connected = $script:Connected
    }
}

function Invoke-Connect {
    param([string] $Id, $Request)
    $certificate = $Request['certificate']
    $certificatePem = $null
    $privateKeyPem = $null
    try {
        if ($certificate -isnot [System.Collections.IDictionary] -or $certificate['format'] -ne 'pem') { Send-Failure $Id 'invalid_argument'; return }
        $certificatePem = [string] $certificate['certificate']
        $privateKeyPem = [string] $certificate['privateKey']
        if ([string]::IsNullOrWhiteSpace($certificatePem) -or [string]::IsNullOrWhiteSpace($privateKeyPem)) { Send-Failure $Id 'invalid_argument'; return }
        Import-ExchangeModule
        if ($CertificateMode -eq 'tmpfs') { Connect-WithTmpfsFile ([string] $Request['appId']) ([string] $Request['organization']) $certificatePem $privateKeyPem }
        else { Connect-InMemory ([string] $Request['appId']) ([string] $Request['organization']) $certificatePem $privateKeyPem }
        $script:Connected = $true
        Send-Ok $Id (Get-Hello)
    } catch {
        $script:Connected = $false
        Send-ConnectFailure $Id $_
    } finally {
        $certificatePem = $null
        $privateKeyPem = $null
    }
}

# ------------------------------------------------------------------------------------------------
# A call
# ------------------------------------------------------------------------------------------------

function ConvertTo-Parameters {
    param([string] $Name, $Arguments)
    $spec = $script:AllowList.cmdlets[$Name]
    $parameters = [ordered]@{}
    foreach ($key in @($Arguments.Keys)) {
        $kind = [string] $spec.params[[string] $key].kind
        $value = $Arguments[$key]
        switch ($kind) {
            'switch' { $parameters[[string] $key] = [System.Management.Automation.SwitchParameter]::new($true) }
            'boolean' { $parameters[[string] $key] = [bool] $value }
            'resultSize' { $parameters[[string] $key] = $(if ($value -is [string]) { $value } else { [int] $value }) }
            'enumList' { $parameters[[string] $key] = [string[]] @($value) }
            'identifierList' { $parameters[[string] $key] = [string[]] @($value) }
            default { $parameters[[string] $key] = [string] $value }
        }
    }
    if ($spec.confirmFalse -eq $true) { $parameters['Confirm'] = $false }
    $parameters['ErrorAction'] = 'Stop'
    $parameters['WarningAction'] = 'SilentlyContinue'
    $parameters['InformationAction'] = 'SilentlyContinue'
    return $parameters
}

function Invoke-Call {
    param([string] $Id, $Request)
    $name = $Request['cmdlet']
    $arguments = $Request['args']
    if ($name -isnot [string]) { Send-Failure $Id 'invalid_argument'; return }
    try { Assert-AllowedCall $name $arguments } catch { Send-Failure $Id 'invalid_argument'; return }
    if (-not $script:Connected) { Send-Failure $Id 'not_connected'; return }
    try {
        $command = Get-Command -Name $name -CommandType Cmdlet, Function -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { Send-Failure $Id 'role_pending'; return }
        $parameters = ConvertTo-Parameters $name $arguments
        Assert-AllowedCall $name $arguments
        $result = & $command @parameters 6>$null 5>$null 4>$null 3>$null
        $data = Get-ResultData $name $result
        $json = ConvertTo-Json -InputObject ([ordered]@{ v = $script:ProtocolVersion; id = $Id; ok = $true; data = $data }) -Depth 8 -Compress
        if ($script:Utf8.GetByteCount($json) -gt $script:LineMaxBytes) { Send-Failure $Id 'internal'; return }
        $script:ProtocolOut.WriteLine($json)
        $script:ProtocolOut.Flush()
    } catch {
        Send-ErrorRecord $Id $_
    }
}

# ------------------------------------------------------------------------------------------------
# The loop
# ------------------------------------------------------------------------------------------------

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Length -eq 0) { continue }
    $id = 'invalid-request'
    $request = $null
    try {
        if ($script:Utf8.GetByteCount($line) -gt $script:LineMaxBytes) { throw 'too_long' }
        $request = ConvertFrom-Json -InputObject $line -AsHashtable
    } catch {
        Send-Failure $id 'invalid_argument'
        continue
    }
    if ($request -isnot [System.Collections.IDictionary]) { Send-Failure $id 'invalid_argument'; continue }
    $candidate = $request['id']
    if ($candidate -is [string] -and [regex]::IsMatch($candidate, $script:RequestIdPattern)) { $id = $candidate }
    else { Send-Failure $id 'invalid_argument'; continue }
    if ($request['v'] -ne $script:ProtocolVersion) { Send-Failure $id 'invalid_argument'; continue }

    # Whatever happens while a request is served is an answer with a code, never the end of the process:
    # only `shutdown` (and the end of stdin) leaves the loop.
    try {
        switch ([string] $request['type']) {
            'ping' {
                if ($null -eq $script:ModuleVersion) { try { Import-ExchangeModule } catch { $script:ModuleVersion = $null } }
                Send-Ok $id (Get-Hello)
            }
            'connect' { Invoke-Connect $id $request }
            'call' { Invoke-Call $id $request }
            'shutdown' {
                Send-Ok $id ([ordered]@{ done = $true })
                if ($script:Connected) { try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch { $null = $_ } }
                exit 0
            }
            default { Send-Failure $id 'invalid_argument' }
        }
    } catch {
        try { Send-Failure $id 'internal' } catch { $null = $_ }
    }
}
