# Owner test sheet, Phase D step D1: Exchange worker, distribution lists, contacts, group members

> Nederlandse versie: zie [Nederlands](#nederlands). This is the step list for the owner-verified checks
> **OV-D1, OV-D2, OV-D4 and OV-D5** of `specs/004-phase-d/spec.md` section 8.4. Everything here needs a real
> Microsoft 365 **test tenant** (never production): the automated tests run against a simulated Exchange, a
> simulated Graph and a stand-in for the worker, so only you can show how Microsoft really answers. The checks
> close or narrow the unverified claims **U75 to U85, U89, U90 and U92 to U100** (register in
> [open-points.md](open-points.md)). The phase report [phase-D1.md](phase-reports/phase-D1.md) hands you this
> sheet; fill in the result table at the end and send back only what "What to report back" allows. The sheet also
> asks you for one decision, **the image size ceiling** (section J).

## English

### How long, and what you need

About **90 minutes** of work (A 3, B 5, C 5, D 5, E 5, F 10, G 20, H 20, I 10, J 3, K 4) plus a wait of about 30
minutes before step 38 (the Exchange audit log is slow). The panel keeps working whatever the answers are: every
unverified claim has a designed fallback (a message, never a silent success), so a "fail" is information for the
next version, not a broken installation. **Everything you write to the tenant here is test data you create
yourself; section K deletes it again.**

You need:

- The Phase D step D1 image (Ubuntu 24.04 with PowerShell 7.6.x and the ExchangeOnlineManagement module), started
  with the Compose file of the repository (read-only root, `/tmp` tmpfs, all capabilities dropped). Below,
  `panel` is the name of the container. Pull the new image and recreate the container; the volume, the port and
  the sign-in are unchanged. Step D1 adds one optional variable, `EXCHANGE_KEY_HANDOVER` (default `memory`).
- A **test tenant** where the Phase B wizard has finished (the wizard grants `Exchange.ManageAsApp` and the
  Exchange Administrator role to the application), and you can sign in to the panel as **G**, the Owner.
- **A build whose Exchange credential source is finished.** Sections A to F (OV-D1) talk to the worker script
  directly with a test certificate and **do not need it**. Sections G (Exchange part), H and I need the panel
  itself to connect to Exchange. The certificate format is decided (PEM) and the change was still in progress when
  this sheet was written (open-points.md, FD-01). If the **Distribution lists** page of your build only says that
  Exchange is unavailable (503 `exchange_unavailable` in the Network tab) and the Settings, Connection page shows the
  roles as granted for more than 15 minutes, the credential source is not in your build: answer the Exchange
  steps of G, H and I **Not tested**, but still do the group steps of G (13, 22 to 24), which use only Microsoft Graph.
- The **application (client) id** and the **primary `.onmicrosoft.com` domain** of the tenant (Entra admin
  center, App registrations). Keep them in shell variables `APP_ID` and `ORG`, not in your notes.
- A **test certificate** for the worker steps of section B. The panel's own certificate cannot be exported (its
  key stays sealed in the database), so make a separate one on your computer and put its public half on the
  application registration for the duration of the test:

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=m365portal-ovd1" \
    -keyout ovd1.key -out ovd1.crt
  openssl pkcs8 -topk8 -nocrypt -in ovd1.key -out ovd1.pk8.pem
  ```

  Upload `ovd1.crt` (the public part only) under the application registration, Certificates & secrets,
  Certificates. **Delete it again in section K.** The files `ovd1.key` and `ovd1.pk8.pem` hold a private key: keep
  them out of the repository and out of cloud folders, and delete them after the test.
- **Test data**, made once by you in the Exchange admin center (https://admin.exchange.microsoft.com), the
  Entra admin center (https://entra.microsoft.com) and Microsoft 365 admin center: a distribution list **L1** (you
  are its owner, the application is **not**), three users **U1**, **U3** (with a mailbox) and **U2** (no mailbox,
  for example no licence), a cloud security group **G1** with assigned membership, a **role-assignable** group
  **R1** (Entra, "Microsoft Entra roles can be assigned to the group": Yes). If you have them, also: a dynamic
  distribution list **L2**, anything synchronised from on-premises (a list, a contact, a group), a group with
  hidden membership. Whatever is missing is answered "Not tested".
- A terminal with `docker`, `openssl`, `base64` and `jq`, and a Chromium or Firefox browser with the developer tools
  (F12, tab **Network**).

**Read this before you start: what you may copy.** The panel and Exchange show real names and addresses on
screen, in the Network tab and in the worker's answers. That is for your eyes only. In your notes and in what you
send back write numbers, words such as "present", "added", "failed" or "restricted", HTTP status codes, the
`code` values of the worker and the reason words of the panel. **Never copy** a name, an e-mail address, a user
principal name, a list or object id, a tenant or application id (not even from the address bar), the contents of
the test files, a token, a cookie, or a screenshot that shows any of these.

### A. OV-D1: look at the image (3 minutes, U83, U84)

1. `docker exec panel /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString(); (Get-Module -ListAvailable ExchangeOnlineManagement).Version.ToString()'`
   Expect a version that starts with `7.6.` and the module version pinned in the `Dockerfile` (`EXO_VERSION`,
   3.10.1 for this build). Write both down (**U83** is closed by the pin: the pinned version has REST for every
   cmdlet used; if a cmdlet answers "not supported" in step 9, report it).
2. `docker image inspect --format '{{.Size}}' <image>`: write the size in megabytes (1 MB = 1,000,000 bytes). This
   is **U84** and the number for the decision in section J.
3. Time the start of the worker: `time (printf '%s\n' '{"v":1,"type":"ping","id":"a1b2c3d4-00000001"}' '{"v":1,"type":"shutdown","id":"a1b2c3d4-00000002"}' | docker exec -i -e HOME=/tmp panel /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -File /app/dist/exchange/worker-script.ps1)`
   The first line of the answer names `moduleVersion`, `psVersion` and two hashes. Write down the elapsed time
   (**U84**, start of `pwsh` plus the module import).

### B. OV-D1: connect with the certificate in memory (5 minutes, U75, U76, U77)

4. In the terminal that has `APP_ID` and `ORG`, build the connect line and keep it in a file that only you can read
   (it holds the key; delete it in section K). The certificate travels as PEM text, the key as PKCS#8:

   ```sh
   umask 077
   jq -cn --arg app "$APP_ID" --arg org "$ORG" --rawfile crt ovd1.crt --rawfile key ovd1.pk8.pem \
     '{v:1,type:"connect",id:"a1b2c3d4-00000010",appId:$app,organization:$org,certificate:{format:"pem",certificate:$crt,privateKey:$key}}' > connect.json
   jq -cn '{v:1,type:"call",id:"a1b2c3d4-00000011",cmdlet:"Get-DistributionGroup",args:{ResultSize:1}}' > call.json
   jq -cn '{v:1,type:"shutdown",id:"a1b2c3d4-00000012"}' > shutdown.json
   ```

   If your build answers `invalid_argument` to every connect line, it still expects the older PKCS#12 shape
   (`format:"pfx-base64"`, `data`, `password`); the phase report says which shape the build has. Report which one
   you used.
5. Run the worker with these three lines and **do not copy the answer**; look at the shape only:

   ```sh
   cat connect.json call.json shutdown.json | docker exec -i -e HOME=/tmp panel \
     /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -File /app/dist/exchange/worker-script.ps1 \
     | jq -c '{id, ok, code: .error.code, rows: (.data.rows | if type=="array" then length else null end)}'
   ```

   - Answer 1 (connect): `ok: true`. Answer 2 (call): `ok: true` with `rows` 0 or 1. **This is U75 true**: the
     certificate was used from memory on Linux.
   - If answer 1 is `ok: false`, write down the `code` (for example `permission_denied`, `role_pending`,
     `invalid_argument`, `internal`). `role_pending` means the role was granted minutes ago: wait 5 minutes and run
     step 5 again (how long it took is also a result for **U76**). Any other code: go to step 8.
6. **U76:** if answer 2 is `permission_denied` while answer 1 was fine, the role of the application is not enough
   for the read cmdlets. Write that down with the name of the role that is on the application (Entra admin center,
   the application's Enterprise application, Roles and administrators).
7. **U77:** in Entra, application registration, API permissions, APIs my organization uses, Office 365 Exchange
   Online: write down which application permissions exist (only `Exchange.ManageAsApp`, or also a V2 variant).
   Names only.

### C. OV-D1: the fallback, only if step 5 failed with `internal` or `invalid_argument` (5 minutes, U75)

8. Make a private scratch directory and run the worker in the `tmpfs` mode, which writes the key to a file with
   mode 0600 for the time of the connect and removes it again:

   ```sh
   docker exec panel sh -c 'umask 077; mkdir -p /dev/shm/m365-exchange-ovd1'
   cat connect.json call.json shutdown.json | docker exec -i -e HOME=/tmp panel \
     /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -File /app/dist/exchange/worker-script.ps1 \
     -CertificateMode tmpfs -ScratchDirectory /dev/shm/m365-exchange-ovd1 \
     | jq -c '{id, ok, code: .error.code}'
   docker exec panel sh -c 'ls -A /dev/shm/m365-exchange-ovd1 | wc -l'
   ```

   Record whether the connect now works and that the last command prints **0** (the file is gone). If it works, U75
   is **false** for the in-memory path; set `EXCHANGE_KEY_HANDOVER=tmpfs` in `.env` (the Compose file passes it) and
   recreate the container, and tell the next version. `docs/operations.md` explains the residual risk. Remove the
   directory afterwards: `docker exec panel rmdir /dev/shm/m365-exchange-ovd1`.

### D. OV-D1: which cmdlets answer (5 minutes, U83)

9. Repeat step 5 with each of these in `call.json` instead of `Get-DistributionGroup` (the arguments are the ones
   the panel uses), and write down only `ok` and `code`:

   | cmdlet | args |
   |---|---|
   | `Get-DistributionGroup` | `{"ResultSize":5}` |
   | `Get-MailContact` | `{"ResultSize":5}` |
   | `Get-Recipient` | `{"RecipientTypeDetails":["DynamicDistributionGroup"],"ResultSize":5}` |
   | `Get-OrganizationConfig` | `{}` |
   | `Get-DistributionGroupMember` | `{"Identity":"<GUID of L1>","ResultSize":"Unlimited"}` (do not write the GUID down) |

   Calls that are not on the allow-list are refused by the worker with `invalid_argument` before Exchange is asked;
   that is by design and not a finding. Only the read cmdlets are tried here.

### E. OV-D1: no key on disk (5 minutes, U75)

10. In a **second terminal**, while a worker is running (start step 5 with a `sleep 30` before the `shutdown` line:
    `(cat connect.json call.json; sleep 30; cat shutdown.json) | docker exec -i ...`), run:

    ```sh
    docker exec panel sh -c 'ls -la /tmp /dev/shm; find / -xdev -newer /proc/1/cmdline -type f -not -path "/proc/*" 2>/dev/null | head -50'
    docker exec panel sh -c 'grep -rl "BEGIN .*PRIVATE KEY" /tmp /dev/shm /data /home 2>/dev/null | wc -l'
    ```

    Report: the **number** of files found by the second command (expect **0** in `memory` mode; in `tmpfs` mode at
    most 1 and only during the connect), and whether any file name in the first command looks like it belongs to a
    certificate or a key (yes or no, not the name). Also check that after the worker ended `/dev/shm` holds nothing
    that starts with `m365-exchange-` other than your own scratch directory.

### F. OV-D1: memory and a long session (10 minutes, U84, U85)

11. While the worker of step 10 runs, `docker stats --no-stream panel` and write the memory figure in MiB (**U84**,
    resident memory of a warm session).
12. **U85:** do this shorter variant: keep one worker open for 15 minutes with a call at minute 0 and one at minute
    14 (`(cat connect.json call.json; sleep 840; sed 's/00000011/00000013/' call.json; cat shutdown.json) | docker exec -i ...`).
    Report whether the second call answered `ok: true` or returned `not_connected` or `internal` (whether the module
    renews its own token). The panel restarts such a worker by design, once per failed call.

### G. OV-D2: member writes without manager rights (20 minutes, U78, U82, U92, U93, U94, U96)

Sign in to the panel as **G**. In the Network tab keep "Preserve log" on. The application is not the owner of L1
(step 0 of the test data), so these steps show whether the service principal can change a list it does not manage.

13. **Groups (Microsoft Graph, no Exchange needed).** Open **Groups**, open **G1**. In the members section press
    **Add members**, search the first letters of U1, tick it, press **Add 1 member**. Expect the result table
    "Result of the last change" with **Added**. Press **Add members** again and search U1 again: if the picker lets you
    tick it, add it and expect **No change needed**; if it disables it as "Already a member", write "disabled". Then tick U1 in the member
    table and press **Remove selected**, confirm **Remove 1 member**: expect **Removed**. Report the three words
    (**U92 and U93** are exercised only if you see "Microsoft refused the change" for a plain add or remove; the
    panel reads the membership first, so a duplicate add or a removal of a non-member does not reach Microsoft
    from the screen).
14. Open **Distribution lists**, open **L1**. Expect the properties (Name, Type "Distribution list", Members count)
    and the member table. Press **Add members**, search U1, tick it, **Add 1 member**. Expect **Added** (this is
    **U78 with the bypass**: the panel always sends `-BypassSecurityGroupManagerCheck`). If you see **Failed** with
    "The panel has no permission for this change", or a message that Exchange refused the application, write the
    words down: U78 is false and the Exchange role is not enough.
15. **U82:** if the note "The change is made, but Exchange can take a moment to show it in the member list" is shown,
    press **Refresh the members** every 10 seconds and write down how many seconds until U1 appears. If the note is
    not shown, write "none".
16. Press **Add members** again and search U1: the picker must show U1 as "Already a member" and not let you select
    it. If it does **not** mark U1, that is a finding: the member ids of Exchange and the user ids of Graph do not
    match (**U98**). Write "marked" or "not marked".
17. Add U2 (no mailbox) to L1. Expect **Failed** with "The user has no mailbox or email address, so cannot be a
    member".
18. **U78 without the bypass, and U94, directly at the worker** (needs section B to have worked). Put the GUID of
    L1 in `LIST_ID` (from the address bar of the panel page, do not write it down) and the e-mail addresses of U3
    and U1 in `A3` and `A1`:

    ```sh
    one() { jq -cn --arg l "$LIST_ID" --arg m "$2" --argjson extra "$3" "{v:1,type:\"call\",id:\"a1b2c3d4-0000002$1\",cmdlet:\"$4\",args:({Identity:\$l,Member:\$m} + \$extra)}"; }
    { cat connect.json
      one 1 "$A3" '{}' Add-DistributionGroupMember                                  # U3 is not a member, no bypass
      one 2 "$A1" '{"BypassSecurityGroupManagerCheck":true}' Add-DistributionGroupMember   # U1 already is a member
      one 3 "$A3" '{"BypassSecurityGroupManagerCheck":true}' Remove-DistributionGroupMember
      one 4 "$A3" '{"BypassSecurityGroupManagerCheck":true}' Remove-DistributionGroupMember  # U3 is no member any more
      cat shutdown.json; } | docker exec -i -e HOME=/tmp panel \
      /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -File /app/dist/exchange/worker-script.ps1 \
      | jq -c '{id, ok, code: .error.code}'
    ```

    The first answer is the connect line; the next four have the ids ending in 21 to 24. Answer 21 (add U3
    **without** the bypass): `ok: true` means the service principal's role satisfies the manager check (**U78**);
    `manager_check` means the bypass is needed. Answer 22 (add a member that is already in the list) and answer 24
    (remove U3 a second time, who is certainly not a member any more): `ok: true` means Exchange succeeds silently,
    `already_member` or `not_a_member` means it answers an error (**U94**). Answer 23 only cleans up U3. Write down
    the four `ok` and `code` pairs. The panel is built for both answers (it reads the membership first).
19. Back in the panel, remove U1 from L1: tick it in the member table, **Remove selected**, **Remove 1 member**.
    Expect **Removed** and, after a refresh, U1 gone.
20. **Dynamic and synchronised lists (only if you have them).** Open L2 (dynamic): expect the badge **Read-only**
    next to the name, the text that the members of a dynamic list follow a rule, **no** Add or Remove button, and an
    empty member table (a known finding: the empty table does not say that the members cannot be listed, FD-05).
    A synchronised list: **Read-only** and the synchronisation text. Report yes or no for each.
21. **More than 20 members (optional, needs 21 disposable test users).** Add 21 users to L1 in one go. Expect a
    note "More than 20 members need a fresh sign-in", then the sign-in dialog; after signing in again repeat the add:
    21 results. Remove them in one go the same way. Report yes or no.
22. **U96:** open **R1** (the role-assignable group) in Groups, **Add members**, add U1. Expect **Failed** with "The
    panel has no permission for this change" (Graph refuses a role-assignable group without
    `RoleManagement.ReadWrite.Directory`, which the panel never holds). Report the reason word you see; if U1 was
    added, say so.
23. Open a **dynamic** or **synchronised** group, or a distribution list or mail-enabled security group, in Groups
    (any you have): expect no **Add members** button and a text that the members cannot be changed here. A group
    with hidden membership shows no editor.
24. Look in the Network tab at the write requests of steps 13 to 19: each answer is `200` with a body of
    `results`, `summary` and (lists only) `readBackPending`; write the status of any request that is not `200`.

### H. OV-D5: contacts and synced objects (20 minutes, U15, U79, U80, U95, U97, U98, U99)

Open **Contacts**. Use e-mail addresses of mailboxes you own for the external addresses (nothing is sent to them).

25. Press **New contact**. Enter a display name, an alias and an external address (the form says the address is
    saved in lower case) and press **Create contact**. Expect the message "The contact was created" and the contact
    in the list. Open it: expect the properties (Display name, Alias, External email address, First name, Last name,
    Hidden from address lists, Created) and the section **Distribution lists** ("not in any distribution list").
26. **U97 (duplicate check):** create another contact with the **same external address** and a different alias.
    Expect the form to show the error at the address field and no second contact. Then one with the same alias and
    another address: error at the alias field. **If a second contact with the same address is created, U97 is false**
    (the prefix search that finds duplicates does not match the external address): report it.
27. **U95:** create a contact with the **same display name** as the first one but another alias and address.
    Expect "The contact was created" (the Exchange name is derived with a short suffix, so a clash does not occur).
    If it fails, write the reason word.
28. Open the first contact, **Edit contact**, change only the display name, **Save changes**: expect "The contact
    was saved" (**U15**: the form has no name fields to change; first and last name can be set at creation only).
    Press **Edit contact** again and save without a change: expect "Change at least one field".
29. Go to L1 and add the first contact to it with **Add members** (the picker also finds contacts; expect **Added**).
    The member table shows it with the kind **Contact** and its address. **U98:** the picker now shows the contact
    as "Already a member". Reopen the contact: the section **Distribution lists** must now list L1
    (**U97, the membership filter**); if the section shows an error or stays empty although the contact is a member,
    write that down.
30. **U79, U99:** on **Distribution lists**, search the first letters of the name of L1 and of its address: expect
    L1 in both cases. Use the filter **List type** with each value (all, standard, dynamic, synchronised): the list
    narrows without an error. The list shows the member count as a dash and the detail page the count (**U79**:
    whether the count is right). Write down yes or no for: search works, filter works, count is right.
31. **U98:** the **Managers** column of L1 shows the people you made owner as names (not as addresses and not
    empty). Report "names", "addresses" or "empty".
32. **Delete.** Open the second contact (from step 27), press **Delete contact**. Expect the text "The contact is
    removed from Exchange and cannot be restored.", and for the first contact (a list member) the text that it will
    be removed from 1 distribution list. Type a **wrong** name: the button stays off or the error "The name you typed
    does not match the contact" appears. Type the display name exactly and confirm. Expect "The contact was
    deleted" with the number of lists. Do the same for the first contact: expect "...removed from 1 list" and L1
    no longer lists it.
33. **U80 (synchronised objects, only if you have them).** A synchronised contact or list: the Contacts list shows
    **Source: Synchronised**, the detail says it is synchronised from on-premises and offers **no** Edit and
    Delete button. Report yes or no. If the tenant has none, "Not tested".
34. A contact that does not exist: open `/contacts/<a made-up GUID>` in the address bar: expect an error state,
    not data (404).
35. Confirm that nothing in Exchange was changed behind your back: the second and first contact are gone in the
    Exchange admin center, and L1 has no members that you did not add.

### I. OV-D4: the Exchange audit log of the panel's changes (10 minutes, plus the wait, U89, U90)

Do this last, at least **30 minutes** after the first write of section G (Learn: an Exchange cmdlet run can take up to
30 minutes to appear; the log keeps 180 days). The panel keeps its own audit trail of every write; the Exchange log
is a second source you cross-check.

36. In your own Exchange Online PowerShell session as yourself (not the application), search the window of this test
    and print only counts per operation:

    ```powershell
    Search-UnifiedAuditLog -StartDate (Get-Date).AddHours(-4) -EndDate (Get-Date) -RecordType ExchangeAdmin -ResultSize 500 |
      Group-Object Operations | Select-Object Count, Name
    ```

    Or use the Microsoft Purview portal, Audit, with the Exchange admin activities of the same window. Expect
    operations named like the cmdlets: `Add-DistributionGroupMember`, `Remove-DistributionGroupMember`,
    `New-MailContact`, `Set-MailContact`, `Remove-MailContact`. Write down, for each of the five, the **count** (0 means
    **not logged**: **U90** for that cmdlet).
37. **U89:** open one entry of an `Add-DistributionGroupMember` that the panel made (its time matches step 14 or
    19) and note only: whether the user field shows a person, the application, or something that looks like a
    GUID (**U89**: how the service principal is identified), and whether the parameters list
    `BypassSecurityGroupManagerCheck`. If **no** entry of the panel's runs exists although the cmdlets ran, U89 is
    false: Exchange does not log runs by a service principal, and the panel's own audit is the only record.
38. In the panel run `docker exec panel /nodejs/bin/node dist/cli.js verify-audit`: it must print one JSON line
    and exit 0 (the chain is intact after the writes). Report the exit code. (The panel's own audit entries are
    visible in the audit screen of step D2; until then the chain check is all you can see.)

### J. The image size decision (3 minutes)

The new image is larger than the old ceiling of 400 MB (estimated 500 to 550 MB, never measured), and the CI step
`Image size budget` fails until the ceiling is set. **Decision requested from you:** the ceiling for the runtime
image. Step 2 gave you the measured size in MB. Options:

- **A.** Set the ceiling to the measured size plus a margin you accept (for example +10 percent). Tell the number;
  it is then changed in `scripts/check_image_size.py` and `packages/shared/src/limits.ts` together and written
  into ADR-0180.
- **B.** The size is too large for you: ask for a smaller image (the options are a smaller set of libraries, a
  slimmer module, or a separate worker container, which is ODB-01 B and a new decision).

Write the measured size and your choice in the result table. The ceiling is yours; nobody raises it to make CI green.

### K. Clean up and report back (4 minutes)

39. Delete the test certificate from the application registration (Certificates & secrets). Delete `ovd1.key`,
    `ovd1.crt`, `ovd1.pk8.pem`, `connect.json`, `call.json`, `shutdown.json` and any other `*.json` you made; unset
    `APP_ID` and `ORG`. If you set `EXCHANGE_KEY_HANDOVER=tmpfs` only for the test and it was not needed, remove it
    and recreate the container.
40. Remove the test data you made that you do not want to keep (L1, L2, U1 to U3, G1, R1), and any contact left
    over. In L1, G1 and R1 check that no member is left that you did not put there.
41. Reopen **Settings, Connection**: the roles are still shown as granted and no new consent was asked at any
    point. Step D1 asks Microsoft for no new permission; if a consent screen ever appeared, stop and report that.

#### What to report back

One line per check, in this table. Allowed: a result word, numbers, seconds, milliseconds, MiB, MB, HTTP status
codes, the `code` of the worker, the reason words of the panel, version strings and the names of roles and
permissions. **Not allowed:** names, addresses, any id, tokens, the contents of the files, or screenshots showing
these.

| Item | Result (Pass, Fail, Not tested) | Facts to report |
|---|---|---|
| OV-D1 (steps 1 to 12) | | PowerShell and module versions; image size in MB; seconds from start to the ping answer. Did the in-memory connect work (U75: yes or no), which connect shape you used, the `code` if not and whether `tmpfs` worked and left 0 files; the number of files with a key found while the worker ran; whether every read cmdlet of step 9 answered, the role on the application and the minutes until `role_pending` ended (U76); which Exchange application permissions exist (U77); which cmdlets answered `not supported` (U83); resident memory in MiB (U84); whether the call after 14 idle minutes worked without a new connect (U85). |
| OV-D2 (steps 13 to 24) | | Words for each step: group add, repeat and remove (13); list add (14, U78 with bypass) and the seconds until it showed (15, U82); repeat add (16); no-mailbox reason (17); the four `ok` and `code` pairs of step 18 (U78 without the bypass, U94); remove (19); dynamic and synchronised lists read-only (20); step-up above 20 (21); role-assignable group reason (22, U96); other read-only groups (23); any status other than 200 (24). Whether you ever saw "Microsoft refused the change" for a plain add or remove (U92, U93). |
| OV-D4 (steps 36 to 38) | | Counts per operation for the five cmdlets (U90); whether the user field of the panel's entry shows a person, the application, a GUID or nothing (U89); whether `BypassSecurityGroupManagerCheck` appears in the parameters; the exit code of `verify-audit`. |
| OV-D5 (steps 25 to 35) | | Created, duplicate address refused (yes or no, U97), duplicate alias refused, same display name created (U95), saved and "Change at least one field" (U15), the contact in L1 and "Already a member" (U98), the contact's Distribution lists section listed L1 (U97), search and kind filter work and the count is right (U79, U99), Managers as names, addresses or empty (U98), delete message and lists count, wrong name refused, synchronised objects read-only (U80). |
| Image size decision (J) | | The measured size in MB and your choice (A with the ceiling in MB, or B). |

If you see something you cannot explain, describe in words what you saw and stop. Do not try again in a way that
changes data. The questions that follow from your answers (keep the in-memory path or switch to `tmpfs`, a narrower
role than Exchange Administrator, the bypass, the image size ceiling, whether to continue to step D2) are decisions
for the report of step D1.

## Nederlands

> Dit is de stappenlijst voor de door de eigenaar te verifiëren controles **OV-D1, OV-D2, OV-D4 en OV-D5** van
> `specs/004-phase-d/spec.md` sectie 8.4. Alles hier vraagt een echte Microsoft 365-**testtenant** (nooit
> productie): de automatische tests draaien tegen een gesimuleerde Exchange, een gesimuleerde Graph en een
> stand-in voor de worker, dus alleen jij kunt laten zien hoe Microsoft echt antwoordt. De controles sluiten of
> verkleinen de ongeverifieerde claims **U75 tot en met U85, U89, U90 en U92 tot en met U100** (register in
> [open-points.md](open-points.md)). Het fase-rapport [phase-D1.md](phase-reports/phase-D1.md) geeft je dit blad;
> vul aan het eind de resultaattabel in en stuur alleen terug wat "Wat je terugmeldt" toestaat. Het blad vraagt
> ook om één besluit: **het plafond voor de grootte van de image** (sectie J).

### Hoe lang, en wat je nodig hebt

Ongeveer **90 minuten** werk (A 3, B 5, C 5, D 5, E 5, F 10, G 20, H 20, I 10, J 3, K 4) plus ongeveer 30 minuten
wachten vóór stap 38 (het Exchange-auditlog is traag). Het paneel blijft werken, wat de uitkomst ook is: elke
ongeverifieerde claim heeft een ontworpen terugval (een melding, nooit een stil succes), dus een "mislukt" is
informatie voor de volgende versie, geen kapotte installatie. **Alles wat je hier naar de tenant schrijft is
testdata die je zelf maakt; sectie K ruimt haar op.**

Je hebt nodig:

- De Fase D stap D1-image (Ubuntu 24.04 met PowerShell 7.6.x en de module ExchangeOnlineManagement), gestart met het
  Compose-bestand van de repository. Hieronder is `panel` de naam van de container. Haal de nieuwe image op en maak
  de container opnieuw; volume, poort en aanmelding zijn gelijk. Stap D1 voegt één optionele variabele toe,
  `EXCHANGE_KEY_HANDOVER` (standaard `memory`).
- Een **testtenant** waar de Fase B-wizard klaar is (de wizard geeft de applicatie `Exchange.ManageAsApp` en de rol
  Exchange-beheerder) en je als **G**, de Eigenaar, in het paneel kunt aanmelden.
- **Een build waarvan de bron voor de Exchange-inloggegevens af is.** De secties A tot en met F (OV-D1) spreken het
  workerscript direct aan met een testcertificaat en **hebben die niet nodig**. De secties G (Exchange-deel), H en I
  hebben het nodig dat het paneel zelf met Exchange verbindt. Het certificaatformaat is besloten (PEM) en de
  wijziging was bij het schrijven van dit blad nog in uitvoering (open-points.md, FD-01). Zegt de pagina
  **Distributielijsten** van jouw build alleen dat Exchange niet beschikbaar is (503 `exchange_unavailable` in het
  tabblad Network) en toont Instellingen, Verbinding de rollen al ruim 15 minuten als verleend, dan zit de bron er
  niet in: beantwoord de Exchange-stappen van G, H en I met **Niet getest**, maar doe wel de groepsstappen van G (13,
  22 tot en met 24), die alleen Microsoft Graph gebruiken.
- De **applicatie-id (client-id)** en het **primaire `.onmicrosoft.com`-domein**, in shell-variabelen `APP_ID` en
  `ORG`, niet in je aantekeningen.
- Een **testcertificaat** voor de workerstappen van sectie B. Het certificaat van het paneel is niet te exporteren
  (de sleutel blijft verzegeld in de database); maak dus een apart certificaat met de `openssl`-opdrachten uit de
  Engelse versie hierboven, upload alleen `ovd1.crt` bij de applicatieregistratie en **verwijder het weer in sectie
  K**. `ovd1.key` en `ovd1.pk8.pem` bevatten een privésleutel: bewaar ze buiten de repository en cloudmappen en
  verwijder ze na de test.
- **Testdata**, eenmalig door jou gemaakt in het Exchange-beheercentrum, het Entra-beheercentrum en het Microsoft
  365-beheercentrum: een distributielijst **L1** (jij bent eigenaar, de applicatie **niet**), drie gebruikers **U1**,
  **U3** (met mailbox) en **U2** (zonder mailbox, bijvoorbeeld zonder licentie), een cloud-beveiligingsgroep **G1**
  met toegewezen lidmaatschap en een **rol-toewijsbare** groep **R1** (Entra, "Microsoft Entra-rollen kunnen aan de
  groep worden toegewezen": Ja). Als je ze hebt ook: een dynamische distributielijst **L2**, iets dat vanuit
  on-premises is gesynchroniseerd (lijst, contact, groep) en een groep met verborgen lidmaatschap. Wat ontbreekt
  beantwoord je met "Niet getest".
- Een terminal met `docker`, `openssl`, `base64` en `jq`, en een Chromium- of Firefox-browser met de
  ontwikkelaarstools (F12, tabblad **Network**).

**Lees dit voor je begint: wat je mag kopiëren.** Het paneel en Exchange tonen echte namen en adressen op het
scherm, in het tabblad Network en in de antwoorden van de worker; dat is alleen voor jouw ogen. Schrijf in je
aantekeningen en in wat je terugstuurt getallen, woorden als "aanwezig", "toegevoegd", "mislukt" of "beperkt",
HTTP-statuscodes, de `code`-waarden van de worker en de redenwoorden van het paneel. **Kopieer nooit** een naam,
e-mailadres, principalnaam, lijst- of object-id, tenant- of applicatie-id (ook niet uit de adresbalk), de inhoud van
de testbestanden, een token, een cookie of een schermafbeelding daarvan.

### A. OV-D1: de image bekijken (3 minuten, U83, U84)

Stappen 1 tot en met 3, de opdrachten zijn letterlijk dezelfde als in de Engelse versie: de versies van PowerShell
(begint met `7.6.`) en de module (3,10,1 in deze build; **U83** is door de vaste versie gesloten, meld een cmdlet die
"not supported" antwoordt), de grootte van de image in MB met `docker image inspect --format '{{.Size}}' <image>`
(**U84** en het getal voor sectie J) en de tijd tot het antwoord op een `ping` van de worker (**U84**).

### B. OV-D1: verbinden met het certificaat in het geheugen (5 minuten, U75, U76, U77)

Stap 4: bouw met de `jq`-opdrachten van de Engelse versie de `connect`-regel (`format:"pem"`, certificaat als PEM, sleutel
als PKCS#8; een build die nog het oudere PKCS#12-formaat verwacht antwoordt `invalid_argument` op elke
`connect`-regel: meld welk formaat je gebruikte) en de bestanden `call.json` en `shutdown.json`, in een bestand dat
alleen jij kunt lezen. Stap 5: voer de drie regels in de worker uit en **kopieer het antwoord niet**.
`ok: true` bij het antwoord op `connect` en bij `Get-DistributionGroup` betekent dat **U75 klopt** (het certificaat
werd op Linux uit het geheugen gebruikt). Bij `role_pending`: 5 minuten wachten en opnieuw (hoe lang het duurde is
ook een resultaat voor **U76**). Bij een andere `code`: ga naar stap 8. Stap 6 (**U76**): antwoordt de leesopdracht
`permission_denied` terwijl `connect` slaagde, dan volstaat de rol van de applicatie niet; noteer de naam van de
rol. Stap 7 (**U77**): noteer in Entra, API-machtigingen, Office 365 Exchange Online, welke applicatiemachtigingen
bestaan (alleen `Exchange.ManageAsApp` of ook een V2).

### C. OV-D1: de terugval, alleen als stap 5 mislukte met `internal` of `invalid_argument` (5 minuten, U75)

Stap 8: maak een privémap onder `/dev/shm` en draai de worker met `-CertificateMode tmpfs -ScratchDirectory
/dev/shm/m365-exchange-ovd1` (de opdrachten staan in de Engelse versie). Noteer of het verbinden nu werkt en dat het
telcommando **0** bestanden geeft. Werkt het, dan is U75 **onwaar** voor het geheugenpad: zet
`EXCHANGE_KEY_HANDOVER=tmpfs` in `.env`, maak de container opnieuw en meld het; `docs/operations.md` legt het
restrisico uit. Verwijder de map daarna.

### D. OV-D1: welke cmdlets antwoorden (5 minuten, U83)

Stap 9: herhaal stap 5 met de vijf leesopdrachten uit de tabel van de Engelse versie (`Get-DistributionGroup`,
`Get-MailContact`, `Get-Recipient` voor dynamische lijsten, `Get-OrganizationConfig`, `Get-DistributionGroupMember`
met de GUID van L1) en noteer alleen `ok` en `code`. Een aanroep die niet op de toegestane lijst staat, wordt door
de worker met `invalid_argument` geweigerd: dat is zo bedoeld en geen bevinding.

### E. OV-D1: geen sleutel op schijf (5 minuten, U75)

Stap 10: tel in een tweede terminal, terwijl een worker draait (met een `sleep 30` vóór de `shutdown`-regel), de
bestanden met een privésleutel in `/tmp`, `/dev/shm`, `/data` en `/home` (verwacht **0** in `memory`-modus; in
`tmpfs`-modus hoogstens 1 en alleen tijdens het verbinden), meld of een bestandsnaam bij een certificaat of sleutel
lijkt te horen (ja of nee, niet de naam) en controleer dat `/dev/shm` na afloop niets met `m365-exchange-` bevat
behalve je eigen map.

### F. OV-D1: geheugen en een lange sessie (10 minuten, U84, U85)

Stap 11: `docker stats --no-stream panel` terwijl de worker draait; noteer het geheugen in MiB (**U84**). Stap 12
(**U85**): houd één worker 15 minuten open met een aanroep op minuut 0 en een op minuut 14 en meld of de tweede
`ok: true` antwoordde of `not_connected` of `internal` gaf.

### G. OV-D2: ledenwijzigingen zonder beheerdersrechten (20 minuten, U78, U82, U92, U93, U94, U96)

Meld je als **G** aan. Houd in het tabblad Network "Preserve log" aan. De applicatie is geen eigenaar van L1, dus
deze stappen laten zien of de service principal een lijst kan wijzigen die hij niet beheert.

13. **Groepen (Microsoft Graph, geen Exchange nodig).** Open **Groepen**, open **G1**. Druk bij de leden op **Leden
    toevoegen**, zoek de eerste letters van U1, vink aan en druk op **1 lid toevoegen**. Verwacht de tabel "Resultaat
    van de laatste wijziging" met **Toegevoegd**. Zoek U1 opnieuw: laat de zoeklijst je hem aanvinken, voeg hem dan toe en
    verwacht **Geen wijziging nodig**; is hij uitgeschakeld als "Al lid", schrijf dan "uitgeschakeld". Vink U1 aan
    in de ledentabel, **Selectie verwijderen**, bevestig: verwacht **Verwijderd**. Meld de drie woorden (**U92 en
    U93** worden alleen geraakt als je "Microsoft heeft de wijziging geweigerd" ziet bij een gewone toevoeging of
    verwijdering: het paneel leest eerst het lidmaatschap, dus een dubbele toevoeging of het verwijderen van een
    niet-lid bereikt Microsoft vanaf het scherm niet).
14. Open **Distributielijsten**, open **L1**: verwacht de eigenschappen (Naam, Type "Distributielijst", aantal leden)
    en de ledentabel. **Leden toevoegen**, zoek U1, vink aan, **1 lid toevoegen**: verwacht **Toegevoegd** (dit is
    **U78 met de bypass**: het paneel stuurt altijd `-BypassSecurityGroupManagerCheck`). Zie je **Mislukt** met "Het
    paneel heeft geen toestemming voor deze wijziging" of een melding dat Exchange de applicatie weigert, noteer die
    woorden: U78 is dan onwaar en de Exchange-rol volstaat niet.
15. **U82:** staat er de melding "De wijziging is doorgevoerd, maar het kan even duren voordat Exchange haar in de
    ledenlijst toont", druk dan elke 10 seconden op **Leden vernieuwen** en noteer na hoeveel seconden U1
    verschijnt; staat de melding er niet: "geen".
16. Druk opnieuw op **Leden toevoegen** en zoek U1: de zoeklijst moet U1 als "Al lid" tonen en niet laten aanvinken.
    Markeert hij U1 **niet**, dan is dat een bevinding: de lid-id's van Exchange komen niet overeen met de
    gebruikers-id's van Graph (**U98**). Schrijf "gemarkeerd" of "niet gemarkeerd".
17. Voeg U2 (zonder mailbox) toe: verwacht **Mislukt** met "De gebruiker heeft geen postvak of e-mailadres en kan dus
    geen lid zijn".
18. **U78 zonder bypass en U94, direct bij de worker** (vereist dat sectie B gelukt is): zet de GUID van L1 in
    `LIST_ID` en de e-mailadressen van U3 en U1 in `A3` en `A1` en draai het blok uit de Engelse versie. Antwoord 1
    (U3 toevoegen **zonder** bypass): `ok: true` betekent dat de rol van de service principal de beheerderscontrole
    vervult (**U78**), `manager_check` dat de bypass nodig is. Antwoord 2 (een bestaand lid toevoegen) en 4 (een
    niet-lid verwijderen): `ok: true` betekent dat Exchange stil slaagt, `already_member` of `not_a_member` dat het
    een fout geeft (**U94**). Noteer de vier paren `ok` en `code`. Het paneel is voor beide antwoorden gebouwd.
19. Verwijder in het paneel U1 uit L1 (aanvinken, **Selectie verwijderen**, bevestigen): verwacht **Verwijderd** en na
    verversen is U1 weg.
20. **Dynamische en gesynchroniseerde lijsten (alleen als je ze hebt).** L2 (dynamisch): verwacht het label **Alleen
    lezen**, de tekst dat de leden een regel volgen, **geen** knop Toevoegen of Verwijderen en een lege ledentabel (een
    bekende bevinding: de lege tabel zegt niet dat de leden niet te lezen zijn, FD-05). Een gesynchroniseerde lijst:
    **Alleen lezen** en de synchronisatietekst. Meld ja of nee.
21. **Meer dan 20 leden (optioneel, 21 wegwerpgebruikers nodig).** Voeg 21 gebruikers in één keer toe aan L1:
    verwacht de melding "Meer dan 20 leden vragen om een nieuwe aanmelding", het aanmeldvenster en na opnieuw
    aanmelden en herhalen 21 resultaten. Verwijder ze op dezelfde manier. Meld ja of nee.
22. **U96:** open **R1** bij Groepen, voeg U1 toe: verwacht **Mislukt** met "Het paneel heeft geen toestemming voor deze
    wijziging" (Graph weigert een rol-toewijsbare groep zonder `RoleManagement.ReadWrite.Directory`, dat het paneel
    nooit heeft). Meld het redenwoord; is U1 toegevoegd, zeg dat dan.
23. Open een **dynamische** of **gesynchroniseerde** groep, of een distributielijst of e-mailbeveiligde groep, bij
    Groepen: verwacht geen knop **Leden toevoegen** en een tekst dat de leden hier niet te wijzigen zijn; een groep met
    verborgen lidmaatschap toont geen editor.
24. Bekijk in het tabblad Network de schrijfverzoeken van de stappen 13 tot en met 19: elk antwoord is `200` met
    `results`, `summary` en (alleen lijsten) `readBackPending`; noteer de status van elk verzoek dat geen `200` is.

### H. OV-D5: contacten en gesynchroniseerde objecten (20 minuten, U15, U79, U80, U95, U97, U98, U99)

Open **Contacten**. Gebruik als extern adres e-mailadressen van mailboxen die je zelf hebt (er wordt niets naartoe
gestuurd).

25. **Nieuw contact**: weergavenaam, alias en extern adres (het formulier zegt dat het adres in kleine letters wordt
    bewaard), **Contact aanmaken**. Verwacht "Het contact is aangemaakt" en het contact in de lijst. Open het:
    verwacht de eigenschappen en de sectie **Distributielijsten** ("in geen enkele distributielijst").
26. **U97 (dubbelcontrole):** maak een tweede contact met **hetzelfde externe adres** en een andere alias: verwacht
    een fout bij het adresveld en geen tweede contact; dezelfde alias met een ander adres: fout bij het aliasveld.
    **Wordt toch een tweede contact met hetzelfde adres gemaakt, dan is U97 onwaar** (de voorvoegselzoekopdracht die
    dubbelen vindt, vindt het externe adres niet): meld het.
27. **U95:** maak een contact met **dezelfde weergavenaam** als het eerste maar een andere alias en een ander adres:
    verwacht "Het contact is aangemaakt" (de Exchange-naam wordt met een korte suffix afgeleid). Mislukt het, noteer het
    redenwoord.
28. Open het eerste contact, **Contact bewerken**, wijzig alleen de weergavenaam, **Wijzigingen opslaan**: verwacht
    "Het contact is opgeslagen" (**U15**: het formulier heeft geen naamvelden; voor- en achternaam zijn alleen bij het
    aanmaken in te stellen). Sla nogmaals op zonder wijziging: verwacht "Wijzig minstens één veld".
29. Voeg bij L1 het eerste contact toe met **Leden toevoegen** (de zoeklijst vindt ook contacten): verwacht
    **Toegevoegd**; de ledentabel toont het als soort **Contact** met zijn adres. **U98:** de zoeklijst markeert het
    contact nu als "Al lid". Open het contact opnieuw: de sectie **Distributielijsten** moet nu L1 tonen (**U97,
    het lidmaatschapsfilter**); toont ze een fout of niets terwijl het contact lid is, noteer dat.
30. **U79, U99:** zoek bij **Distributielijsten** op de eerste letters van de naam van L1 en van zijn adres: verwacht L1
    in beide gevallen. Gebruik het filter **Type lijst** met elke waarde: de lijst wordt smaller zonder fout. De lijst
    toont het aantal leden als streepje en de detailpagina het aantal (**U79**: of het klopt). Noteer ja of nee voor:
    zoeken werkt, filter werkt, aantal klopt.
31. **U98:** de kolom **Beheerders** van L1 toont de mensen die je eigenaar maakte als namen (niet als adressen en niet
    leeg). Meld "namen", "adressen" of "leeg".
32. **Verwijderen.** Open het tweede contact (stap 27), **Contact verwijderen**: verwacht de tekst dat het contact uit
    Exchange wordt gehaald en niet te herstellen is, en voor het eerste contact (lid van een lijst) dat het uit 1
    distributielijst wordt gehaald. Typ een **verkeerde** naam: de knop blijft uit of de fout "De naam die je typte komt
    niet overeen met het contact" verschijnt. Typ de weergavenaam precies en bevestig: verwacht "Het contact is
    verwijderd" met het aantal lijsten. Doe hetzelfde met het eerste contact: L1 toont het niet meer.
33. **U80 (gesynchroniseerde objecten, alleen als je ze hebt).** Een gesynchroniseerd contact of lijst: de lijst Contacten
    toont **Bron: Gesynchroniseerd**, het detail zegt dat het vanuit on-premises is gesynchroniseerd en biedt **geen**
    knop Bewerken en Verwijderen. Meld ja of nee; zonder zulke objecten "Niet getest".
34. Een contact dat niet bestaat: open `/contacts/<verzonnen GUID>` in de adresbalk: verwacht een foutstatus, geen
    gegevens (404).
35. Controleer dat er in Exchange niets achter je rug is gewijzigd: het tweede en eerste contact zijn weg in het
    Exchange-beheercentrum en L1 heeft geen leden die je niet zelf toevoegde.

### I. OV-D4: het Exchange-auditlog van de wijzigingen van het paneel (10 minuten, plus wachten, U89, U90)

Doe dit als laatste, minstens **30 minuten** na de eerste schrijfactie van sectie G (Learn: een Exchange-cmdlet kan tot
30 minuten duren voor hij verschijnt; het log houdt 180 dagen). Het paneel bewaart zelf een auditspoor van elke
schrijfactie; het Exchange-log is een tweede bron om mee te vergelijken.

36. Zoek in je eigen Exchange Online PowerShell-sessie (als jezelf, niet als de applicatie) het venster van deze test en
    toon alleen aantallen per bewerking (de opdracht staat in de Engelse versie, `Search-UnifiedAuditLog ... -RecordType
    ExchangeAdmin | Group-Object Operations`), of gebruik de Microsoft Purview-portal, Audit. Verwacht bewerkingen met
    de namen van de cmdlets: `Add-DistributionGroupMember`, `Remove-DistributionGroupMember`, `New-MailContact`,
    `Set-MailContact`, `Remove-MailContact`. Noteer per cmdlet het **aantal** (0 betekent **niet gelogd**: **U90** voor
    die cmdlet).
37. **U89:** open één regel van een `Add-DistributionGroupMember` van het paneel (tijd van stap 14 of 19) en noteer
    alleen of het gebruikersveld een persoon, de applicatie of iets als een GUID toont (**U89**: hoe de service
    principal wordt herkend) en of de parameters `BypassSecurityGroupManagerCheck` tonen. Bestaat **geen** regel van de
    uitvoeringen van het paneel terwijl de cmdlets liepen, dan is U89 onwaar: Exchange logt uitvoeringen door een
    service principal niet en alleen de eigen audit van het paneel is het spoor.
38. Draai `docker exec panel /nodejs/bin/node dist/cli.js verify-audit`: het moet één JSON-regel drukken en met 0
    eindigen (de keten is intact na de schrijfacties). Meld de afsluitcode. (De auditregels zelf zijn te zien in het
    auditscherm van stap D2; tot dan is de ketencontrole alles wat je ziet.)

### J. Het besluit over de grootte van de image (3 minuten)

De nieuwe image is groter dan het oude plafond van 400 MB (geschat op 500 tot 550 MB, nooit gemeten) en de CI-stap
`Image size budget` faalt tot het plafond is gezet. **Gevraagd besluit:** het plafond voor de runtime-image. Stap 2 gaf
je de gemeten grootte in MB. **A:** zet het plafond op de gemeten grootte plus een marge die je accepteert (bijvoorbeeld
+10 procent); meld het getal, dat dan in `scripts/check_image_size.py` en `packages/shared/src/limits.ts` samen wordt
gewijzigd en in ADR-0180 wordt vastgelegd. **B:** de grootte is te veel: vraag om een kleinere image (minder
bibliotheken, een slankere module, of een aparte workercontainer, ODB-01 B en een nieuw besluit). Schrijf de gemeten
grootte en je keuze in de resultaattabel. Het plafond is van jou; niemand verhoogt het om CI groen te krijgen.

### K. Opruimen en terugmelden (4 minuten)

39. Verwijder het testcertificaat bij de applicatieregistratie en de bestanden `ovd1.key`, `ovd1.crt`, `ovd1.pk8.pem`,
    `connect.json`, `call.json`, `shutdown.json` en andere `*.json` die je maakte; maak `APP_ID` en `ORG` leeg. Zette je
    `EXCHANGE_KEY_HANDOVER=tmpfs` alleen voor de test en was het niet nodig, haal het weg en maak de container opnieuw.
40. Verwijder de testdata die je niet wilt houden (L1, L2, U1 tot en met U3, G1, R1) en elk overgebleven contact.
    Controleer in L1, G1 en R1 dat er geen lid is dat je er niet zelf in zette.
41. Open **Instellingen, Verbinding**: de rollen staan nog als verleend en er is nergens een nieuwe toestemming gevraagd.
    Stap D1 vraagt Microsoft om geen nieuw recht; verscheen er toch een toestemmingsscherm, stop dan en meld het.

#### Wat je terugmeldt

Eén regel per controle in de tabel van de Engelse versie (Item, Resultaat: Geslaagd, Mislukt of Niet getest, en de
feiten): OV-D1 (stappen 1 tot en met 12), OV-D2 (13 tot en met 24), OV-D4 (36 tot en met 38), OV-D5 (25 tot en met 35)
en het besluit over de grootte van de image (J). Toegestaan: een resultaatwoord, getallen, seconden, milliseconden,
MiB, MB, HTTP-statuscodes, de `code` van de worker, de redenwoorden van het paneel, versienummers en namen van rollen en
machtigingen. **Niet toegestaan:** namen, adressen, id's, tokens, het wachtwoord, bestandsinhoud of schermafbeeldingen
daarvan. Zie je iets dat je niet kunt verklaren, beschrijf het dan in woorden en stop; probeer het niet opnieuw op een
manier die gegevens wijzigt. De besluiten die volgen (geheugenpad of `tmpfs`, een smallere rol dan Exchange-beheerder,
de bypass, het plafond voor de image, of we doorgaan met stap D2) staan in het rapport van stap D1.
