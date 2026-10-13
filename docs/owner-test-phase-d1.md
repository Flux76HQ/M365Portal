# Owner test sheet, Phase D step D1: the Exchange worker (DRAFT)

> Nederlandse versie: zie [Nederlands](#nederlands). **Draft** written by the builder of the worker
> (T-D-110). It is the step list for the owner-verified check **OV-D1** of `specs/004-phase-d/spec.md`
> section 8.4, and it can be run as soon as the first Phase D image is published: it does not need the
> distribution list screens, because it talks to the worker script directly, inside the container. It needs a
> real Microsoft 365 **test tenant** (never production). The automated tests use a simulated Exchange and a
> stand-in for the worker, and run the real script on PowerShell only when `pwsh` happens to be installed;
> only this sheet shows how the real module behaves on Linux. It closes **U75, U76, U77, U83, U84 and U85**.
> OV-D2, OV-D4 and OV-D5 (member writes, audit, contacts) get their own steps in this sheet when the
> screens exist (T-D-192); they are not part of this draft.

## English

### How long, and what you need

About **40 minutes**. The panel keeps working whatever the answers are: the certificate hand-over has a
designed fallback (`EXCHANGE_KEY_HANDOVER=tmpfs`), so a "fail" is information, not a broken installation.

You need:

- The Phase D image (Ubuntu 24.04 with PowerShell 7.6.x and the ExchangeOnlineManagement module), running
  with the Compose file of the repository (read-only root, `/tmp` tmpfs, all capabilities dropped). Below,
  `panel` is the name of the container. Pull the new image and recreate the container.
- A **test tenant** where the Phase B wizard has finished, and the Exchange Administrator role is on the
  application (the wizard grants `Exchange.ManageAsApp` and that role).
- The **application (client) id** and the **primary `.onmicrosoft.com` domain** of the tenant (Entra admin
  center, App registrations). Keep them in shell variables `APP_ID` and `ORG`, not in your notes.
- A **test certificate with its private key in one PKCS#12 file**. The panel's own certificate cannot be
  exported (its key stays sealed in the database), so for this test make a separate one on your computer and
  put its public half on the application registration for the duration of the test:

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=m365portal-ovd1" \
    -keyout ovd1.key -out ovd1.crt
  read -rs PFX_PASSWORD   # type a throw-away password, press Enter
  export PFX_PASSWORD
  openssl pkcs12 -export -inkey ovd1.key -in ovd1.crt -out ovd1.pfx -passout env:PFX_PASSWORD
  ```

  Upload `ovd1.crt` (the public part only) under the application registration, Certificates & secrets,
  Certificates. **Delete it again in step G.** Note that the file `ovd1.pfx` holds a private key: keep it out
  of the repository and out of cloud folders, and delete it after the test.
- A terminal with `docker`, `openssl`, `base64` and `jq`.

**Read this before you start: what you may copy.** The answers of Exchange contain real names and addresses.
They are for your eyes only. In your notes and in what you send back write numbers, words such as "present"
or "not available", HTTP-like status words and the `code` values of the worker. Never copy a name, an
address, an id of the tenant or application, the password of the test certificate, the contents of
`ovd1.pfx`, a token, or a screenshot that shows any of these.

### A. Look at the image (3 minutes, U83, U84)

1. `docker exec panel /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString(); (Get-Module -ListAvailable ExchangeOnlineManagement).Version.ToString()'`
   Expect a version that starts with `7.6.` and the module version pinned in the `Dockerfile`
   (`EXO_VERSION`, 3.10.1 for this build). Write both down (**U83** is closed by the pin: the pinned version
   has REST for every cmdlet used in step D; if a cmdlet answers "not supported" in step D, report it).
2. `docker image inspect --format '{{.Size}}' <image>`: write the size in megabytes (**U84**). The ceiling is
   your decision; ADR-0180 asks for it.
3. Time the start of the worker: `time (printf '%s\n' '{"v":1,"type":"ping","id":"a1b2c3d4-00000001"}' '{"v":1,"type":"shutdown","id":"a1b2c3d4-00000002"}' | docker exec -i -e HOME=/tmp panel /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -File /app/dist/exchange/worker-script.ps1)`
   The first line of the answer names `moduleVersion`, `psVersion` and two hashes. Write down the elapsed time
   (**U84**, start of `pwsh` plus the module import).

### B. Connect with the certificate in memory (5 minutes, U75, U76, U77)

4. In the terminal that has `APP_ID`, `ORG` and `PFX_PASSWORD`, build the connect line and keep it in a file
   that only you can read (it holds the key and the password; delete it in step G):

   ```sh
   umask 077
   jq -cn --arg app "$APP_ID" --arg org "$ORG" --arg pfx "$(base64 -w0 ovd1.pfx)" --arg pw "$PFX_PASSWORD" \
     '{v:1,type:"connect",id:"a1b2c3d4-00000010",appId:$app,organization:$org,certificate:{format:"pfx-base64",data:$pfx,password:$pw}}' > connect.json
   jq -cn '{v:1,type:"call",id:"a1b2c3d4-00000011",cmdlet:"Get-DistributionGroup",args:{ResultSize:1}}' > call.json
   jq -cn '{v:1,type:"shutdown",id:"a1b2c3d4-00000012"}' > shutdown.json
   ```

5. Run the worker with these three lines and **do not copy the answer**; look at the shape only:

   ```sh
   cat connect.json call.json shutdown.json | docker exec -i -e HOME=/tmp panel \
     /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -File /app/dist/exchange/worker-script.ps1 \
     | jq -c '{id, ok, code: .error.code, rows: (.data.rows | if type=="array" then length else null end)}'
   ```

   - Answer 1 (connect): `ok: true`. Answer 2 (call): `ok: true` with `rows` 0 or 1. **This is U75 true**: the
     certificate was used from memory on Linux.
   - If answer 1 is `ok: false`, write down the `code` (for example `permission_denied`, `role_pending`,
     `invalid_argument`, `internal`). `role_pending` means the role was granted minutes ago: wait 5 minutes
     and run step 5 again (that is also a result for **U76**: how long it took). Any other code: go to step 8.
6. **U76:** if answer 2 is `permission_denied` while answer 1 was fine, the role of the application is not
   enough for the read cmdlets. Write that down with the name of the role that is on the application.
7. **U77:** in Entra, application registration, API permissions, Office 365 Exchange Online: write down which
   application permissions exist (only `Exchange.ManageAsApp`, or also a V2 variant). Numbers and role names
   only.

### C. The fallback, only if step 5 failed with `internal` or `invalid_argument` (5 minutes, U75)

8. Recreate the container with `EXCHANGE_KEY_HANDOVER=tmpfs` in the `.env` file (the variable is passed by
   the Compose file), and repeat steps 4 and 5. In `tmpfs` mode the worker script writes the key to a file with
   mode 0600 in a private directory under `/dev/shm`, connects, and removes the file at once. Record whether
   the connect now works. If it does, U75 is **false** for the in-memory path and the fallback stays on; the
   panel and `docs/operations.md` say so.

### D. Which cmdlets answer (5 minutes, U83)

9. Repeat step 5 with each of these in `call.json` instead of `Get-DistributionGroup` (the arguments are the
   ones the panel will use), and write down only `ok` and `code`:

   | cmdlet | args |
   |---|---|
   | `Get-DistributionGroup` | `{"ResultSize":5}` |
   | `Get-MailContact` | `{"ResultSize":5}` |
   | `Get-Recipient` | `{"RecipientTypeDetails":["DynamicDistributionGroup"],"ResultSize":5}` |
   | `Get-OrganizationConfig` | `{}` |
   | `Get-DistributionGroupMember` | `{"Identity":"<GUID of a list>","ResultSize":"Unlimited"}` (a test list of your choice; do not write the GUID down) |

   Calls that are not on the allow-list are refused by the worker with `invalid_argument` before Exchange is
   asked; that is by design and not a finding. Only the read cmdlets are tried here.

### E. No key on disk (5 minutes, U75)

10. In a **second terminal**, while a worker is running (start step 5 with a `sleep 30` before the
    `shutdown` line: `(cat connect.json call.json; sleep 30; cat shutdown.json) | docker exec -i ...`), run:

    ```sh
    docker exec panel sh -c 'ls -la /tmp /dev/shm; find / -xdev -newer /proc/1/cmdline -type f -not -path "/proc/*" 2>/dev/null | head -50'
    docker exec panel sh -c 'grep -rl "BEGIN .*PRIVATE KEY" /tmp /dev/shm /data /home 2>/dev/null | wc -l'
    ```

    Report: the **number** of files found by the second command (expect **0** in `memory` mode; in `tmpfs`
    mode expect at most 1 and only during the connect), and whether any file name in the first command looks
    like it belongs to a certificate or a key (yes or no, not the name). Also check that after the worker ended
    `/dev/shm` holds nothing that starts with `m365-exchange-`.

### F. Memory and a long session (10 minutes, U84, U85)

11. While the worker of step 10 runs, `docker stats --no-stream panel` and write the memory figure in MiB
    (**U84**, resident memory of a warm session).
12. **U85:** a worker that makes one call every 5 minutes for 60 minutes is longer than this sheet allows;
    do this shorter variant: keep one worker open for 15 minutes with a call at minute 0 and one at minute 14
    (`(cat connect.json call.json; sleep 840; sed 's/00000011/00000013/' call.json; cat shutdown.json) | docker exec -i ...`).
    Report whether the second call answered `ok: true` or returned `not_connected` or `internal` (whether
    the module renews its own token). The panel restarts such a worker by design, once per failed call.

### G. Clean up and report back (2 minutes)

13. Delete the test certificate from the application registration (Certificates & secrets). Delete
    `ovd1.pfx`, `ovd1.key`, `ovd1.crt`, `connect.json`, `call.json` and `shutdown.json`; unset
    `PFX_PASSWORD`. If you set `EXCHANGE_KEY_HANDOVER=tmpfs` only for the test and it was not needed, remove it
    and recreate the container.

#### What to report back

One line per check. Allowed: a result word, numbers, milliseconds, MiB, MB, the `code` of the worker, the
version strings of PowerShell and the module, and the names of roles and permissions. **Not allowed:** names,
addresses, any id, tokens, the password, the contents of the files, or screenshots showing these.

| Claim | Result (Pass, Fail, Not tested) | Facts to report |
|---|---|---|
| U75 (steps 4 to 8, 10) | | Did the in-memory connect work (yes or no); if not, the `code` and whether `tmpfs` mode worked; the number of files with a key found while the worker ran. |
| U76 (steps 5, 6) | | Whether every read cmdlet of step 9 answered; the role on the application; minutes until `role_pending` ended. |
| U77 (step 7) | | The application permissions that exist for Exchange Online. |
| U83 (steps 1, 9) | | PowerShell and module versions; which cmdlets answered `not supported`, if any. |
| U84 (steps 2, 3, 11) | | Image size in MB; seconds from start to the ping answer; resident memory in MiB. |
| U85 (step 12) | | Whether the call after 14 idle minutes worked without a new connect. |

If you see something you cannot explain, describe in words what you saw and stop. Do not try again in a way
that changes data. The questions that follow from your answers (keep the in-memory path or switch to
`tmpfs`, a narrower role than Exchange Administrator, the image size ceiling) are decisions for the report of
step D1.

## Nederlands

> Concept, geschreven door de bouwer van de worker (T-D-110). Dit is de stappenlijst voor de
> eigenaar-gecontroleerde check **OV-D1** (`specs/004-phase-d/spec.md` sectie 8.4). Je kunt hem uitvoeren
> zodra de eerste Fase D-image is gepubliceerd: hij gebruikt het worker-script direct in de container en
> heeft de schermen voor distributielijsten niet nodig. Je hebt een echte Microsoft 365 **testtenant**
> nodig (nooit productie). De geautomatiseerde tests gebruiken een gesimuleerde Exchange en een stand-in
> voor de worker; alleen deze lijst laat zien hoe de echte module op Linux werkt. De checks sluiten **U75,
> U76, U77, U83, U84 en U85**. OV-D2, OV-D4 en OV-D5 komen als aparte stappen in dit blad zodra de schermen
> bestaan (T-D-192).

### Hoe lang, en wat je nodig hebt

Ongeveer **40 minuten**. Het paneel blijft werken, wat de uitkomst ook is: de overdracht van het
certificaat heeft een ontworpen terugval (`EXCHANGE_KEY_HANDOVER=tmpfs`).

Je hebt nodig:

- De Fase D-image (Ubuntu 24.04 met PowerShell 7.6.x en de module ExchangeOnlineManagement), gestart met het
  Compose-bestand van de repository. Hieronder is `panel` de naam van de container.
- Een **testtenant** waar de Fase B-wizard klaar is en de applicatie de rol Exchange-beheerder heeft.
- De **applicatie-id (client-id)** en het **primaire `.onmicrosoft.com`-domein**, in shell-variabelen
  `APP_ID` en `ORG`, niet in je aantekeningen.
- Een **testcertificaat met privésleutel in één PKCS#12-bestand**. Het certificaat van het paneel is niet te
  exporteren (de sleutel blijft verzegeld in de database); maak dus een apart certificaat met de
  `openssl`-opdrachten uit de Engelse versie hierboven, upload alleen `ovd1.crt` bij de
  applicatieregistratie en **verwijder het weer in stap G**. `ovd1.pfx` bevat een privésleutel: bewaar het
  buiten de repository en cloudmappen en verwijder het na de test.
- Een terminal met `docker`, `openssl`, `base64` en `jq`.

**Lees dit voor je begint: wat je mag kopiëren.** De antwoorden van Exchange bevatten echte namen en
adressen, alleen voor jouw ogen. Schrijf in je aantekeningen getallen, woorden als "aanwezig" of "niet
beschikbaar" en de `code` van de worker. Kopieer nooit een naam, adres, tenant- of applicatie-id, het
wachtwoord van het testcertificaat, de inhoud van `ovd1.pfx`, een token of een schermafbeelding daarvan.

### Stappen

De stappen 1 tot en met 13 zijn dezelfde als in de Engelse versie hierboven; de opdrachten zijn letterlijk
dezelfde. Samengevat:

- **A (stap 1 tot 3, U83, U84):** versies van PowerShell (begint met `7.6.`) en de module, de grootte van de
  image in MB en de tijd tot het antwoord op een `ping`.
- **B (stap 4 tot 7, U75, U76, U77):** verbinden met het certificaat in het geheugen en één leesopdracht
  (`Get-DistributionGroup`). `ok: true` bij beide antwoorden betekent dat U75 klopt. Bij `role_pending`
  5 minuten wachten en opnieuw proberen (en noteer hoe lang het duurde). Noteer de rol op de applicatie en
  welke Exchange-applicatiemachtigingen bestaan.
- **C (stap 8, alleen als B mislukte met `internal` of `invalid_argument`):** zet
  `EXCHANGE_KEY_HANDOVER=tmpfs` in `.env`, maak de container opnieuw en herhaal B. Werkt het nu, dan is U75
  onwaar voor het geheugenpad en blijft de terugval aan.
- **D (stap 9, U83):** probeer de vijf leesopdrachten uit de tabel; noteer alleen `ok` en `code`.
- **E (stap 10, U75):** tel, terwijl een worker draait, de bestanden met een privésleutel in `/tmp`,
  `/dev/shm`, `/data` en `/home` (verwacht 0 in `memory`-modus) en controleer dat `/dev/shm` na afloop niets
  met `m365-exchange-` bevat.
- **F (stap 11 en 12, U84, U85):** het geheugengebruik in MiB met `docker stats`, en of een tweede aanroep na
  14 minuten stilte nog zonder nieuwe verbinding antwoordde.
- **G (stap 13):** verwijder het testcertificaat bij de applicatieregistratie en alle bestanden uit deze test.

#### Wat je terugmeldt

Eén regel per claim (U75, U76, U77, U83, U84, U85) met Geslaagd, Mislukt of Niet getest en alleen de feiten
uit de Engelse tabel: getallen, MB, MiB, seconden, `code`-waarden, versienummers en namen van rollen en
machtigingen. **Niet toegestaan:** namen, adressen, id's, tokens, het wachtwoord, bestandsinhoud of
schermafbeeldingen daarvan. Zie je iets dat je niet kunt verklaren, beschrijf het dan in woorden en stop. De
besluiten die volgen (geheugenpad of `tmpfs`, een smallere rol dan Exchange-beheerder, het plafond voor de
grootte van de image) staan in het rapport van stap D1.
