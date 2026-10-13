# Owner test sheet, Phase C: users and groups (read only)

> Nederlandse versie: zie [Nederlands](#nederlands). This is the step list for the owner-verified ledger
> **OV-C1 to OV-C6** of `specs/003-phase-c/spec.md` section 8.4. Everything here needs a real Microsoft 365
> **test tenant** (never production): the automated tests run against a simulated tenant, so only you can
> show how Microsoft really answers. The checks close the unverified claims **U66 to U74** (register in
> [open-points.md](open-points.md)). The phase report hands you this sheet; fill in the ledger at the end and
> send back only what section "What to report back" allows.

## English

### How long, and what you need

About **30 minutes** for the checks (A 3, B 6, C 3, D 4, E 4, F 3, G 5, report and clean-up 2 minutes), plus
the time to prepare the test data once. The panel keeps working whatever the answers are: every unverified
claim has a designed fallback (a message, never an error page), so a "fail" below is information for the
next version, not a broken installation.

You need:

- the panel of the Phase C build, connected to a test tenant (the Phase B sheet, steps A to F of
  [phase-B.md](phase-reports/phase-B.md), has been done) and you can sign in as **G**, the Owner. Phase C
  changes no deployment file: no new variable, no Compose line, no migration. Pull the new image, restart
  the container, sign in again. (A restart also ends all list cursors; that is by design.)
- **D**, a test user who holds **no** panel role yet (OV-C6).
- Data in the tenant, found once in the Entra admin center (https://entra.microsoft.com): users with a
  manager and users without; at least one disabled user, one guest, and users in at least two departments,
  one of which (call it **X**) has 2 to 20 users; a Microsoft 365 group with owners; a group with **more
  than 100 direct members** (OV-C4); a security group; a mail-enabled security group and a distribution list
  (Exchange admin center, https://admin.exchange.microsoft.com); and, if you can make or find one, a group
  with **hidden membership** (OV-C5). More than 100 users makes the paging check meaningful (D), more than
  999 users makes it complete. Whatever is missing is answered "not tested".
- A Chromium or Firefox browser. Open the developer tools (F12), tab **Network**, and keep a text file for
  your notes. In the **Console** tab Chrome asks you to type `allow pasting` once before it accepts pasted
  code.

**Read this before you start: what you may copy.** The panel shows real names and addresses on screen and
in the Network tab. That is for your eyes only. In your notes and in what you send back write numbers, words
such as "present", "not available" or "restricted", HTTP status codes and error codes. Never copy a name,
an e-mail address, a user principal name, an object, tenant or application id (not even from the address
bar), a cookie, a token, the `APP_KEY`, the setup token, a certificate, a device code, or a screenshot that
shows any of these.

### A. Prepare (3 minutes)

1. Sign in as G. Open Settings, **Connection**, proof list, "Microsoft Graph permissions": the granted roles
   must include `User.Read.All` and `GroupMember.Read.All`. Phase C asks Microsoft for **no new permission**,
   so no consent screen may appear anywhere in this test; if one does, stop and report that.
2. In the developer tools open **Console** and paste these three helpers (they print numbers only, never
   names):

   ```js
   async function count(path){let n=0,c;do{const u=new URL(path,location.origin);u.searchParams.set('limit','200');if(c)u.searchParams.set('cursor',c);const r=await fetch(u);if(!r.ok)return 'HTTP '+r.status;const j=await r.json();n+=j.items.length;c=j.nextCursor}while(c);return n}
   async function tally(path){const t={};let c;do{const u=new URL(path,location.origin);u.searchParams.set('limit','200');if(c)u.searchParams.set('cursor',c);const r=await fetch(u);if(!r.ok)return 'HTTP '+r.status;const j=await r.json();for(const i of j.items){const k=i.kind??'?';t[k]=(t[k]||0)+1}c=j.nextCursor}while(c);return t}
   async function timeIt(path){const t=performance.now();const r=await fetch(path);const j=await r.json();return [r.status,(j.items||[]).length,Math.round(performance.now()-t)+' ms']}
   ```

   `count('/api/v1/users')` pages through the whole list and returns how many users the list holds (the panel
   itself never shows a total). It stops with `HTTP <status>` if a call fails.

### B. OV-C1: search, filters, order, kinds (U69, U70, U72, U36), 6 minutes

3. Open **Users**. Expected: a table of at most 50 rows, a line "50 users shown" (or fewer), a "Next page"
   button when there are more. Type `a` in "Search by name or email address" and press "Search". Expected:
   only rows whose name, e-mail address or principal name **starts** with "a" (it is a prefix search, not a
   word search) or "No users match". **Fail (U70):** the message "The users could not be loaded". Then open
   the Network tab, click the failed `users` request and note only its status and the `code` in the answer.
4. Choose "Disabled" under "Account state": every row shows State "Disabled". In the Console run
   `await count('/api/v1/users?enabled=false')` and compare the number with the disabled accounts you know
   from the Entra admin center. Write down both numbers.
5. Choose "Guests" under "User type" (account state back to "All accounts"): every row shows Type "Guest".
   Run `await count('/api/v1/users?type=guest')` and `await count('/api/v1/users?type=member')` and
   `await count('/api/v1/users')`. Write down the three numbers and the member and guest counts of the Entra
   admin center. **U72:** if members plus guests is less than all users, users without a type exist
   (they appear in neither filter by design); write down the difference.
6. Click the header "Display name": the order reverses (names from Z to A) and the page shows the order
   in its sort button. Then combine: search `a`, "Disabled", descending. Expected: a list or "No users
   match", **no error**. This is the combination of U70 (prefix search with `or`, two filters and an order).
7. Open **Groups**. Choose each type in turn: "Microsoft 365", "Security", "Mail-enabled security",
   "Distribution". Every row carries that type; the last two also show the badge "Read-only"; under
   "Distribution" a note says that dynamic distribution lists are managed in Exchange and are not listed
   (Microsoft does not return them). In the Console run
   `await count('/api/v1/groups?kind=m365')`, the same for `security`, `mailsecurity`, `distribution`, and
   `await tally('/api/v1/groups')`. Compare the four counts with the Entra admin center and the Exchange
   admin center (which view you used differs per portal version: write it down). A difference of one or two
   can be a change of the last minutes.
8. In the tally, look at `unknown`. **U36/U69:** a group of kind "Unknown" means Microsoft did not return
   `groupTypes`, `mailEnabled` or `securityEnabled` for it; write down how many of the total.
9. Open one group of each kind. Expected: Type, "Mail nickname", "Description", "Visibility" and "Membership"
   (Assigned or Dynamic) are filled where the group has them. **U69:** if "Visibility", "Mail nickname" or
   "Description" shows a dash for **every** group, Microsoft does not return that property to the panel; write
   down which fields.

### C. OV-C2: the manager (U66), 3 minutes

10. Open a user who has a manager (you know from Entra) and read the section **Manager**. Then open a user
    who has none. Repeat for three users with a manager.
11. Expected, one of three outcomes, and all are acceptable:
    - **A (U66 works):** the manager is shown for users who have one, and "No manager" for the user without;
    - **B (U66 refused):** every user with a manager shows "Manager not available", the one without shows
      "No manager". This is what the Learn page predicts for application permissions;
    - **C (mixed):** some users show a manager and some "Manager not available". Write down what they have in
      common if you can see it (no names).

    In both A and B the rest of the user page must work (properties, group memberships). Run
    `docker logs m365portal 2>&1 | grep -c directory_manager_unavailable` and write down the number (the log
    line carries no name or id).

### D. OV-C3: speed and paging to the end (SC-C4, U73), 4 minutes

12. In the Console run `await timeIt('/api/v1/users?limit=100')` twice. Expected: `200`, `100` (fewer if the
    tenant has fewer users) and a time. Write down both times in milliseconds. The first call includes the
    first token and cache fill, the second is the warm one. (The 300 ms in the spec is for the simulated
    tenant; yours depends on Microsoft. It is a measurement, not a pass mark.)
13. Run `await count('/api/v1/users')` and compare with the number of users in the Entra admin center
    (a few seconds old changes aside). Expected: a number, no `HTTP` text. In the **Users** page click "Next
    page" three times and "Previous page" once: no row appears twice, no error, the page text follows
    ("Page 2"). With more than 100 users this follows Microsoft's `nextLink`; with more than 999 users it
    crosses a full Microsoft page.
14. **U73** (does a `nextLink` keep working without the `ConsistencyLevel` header) needs no action from you:
    the panel always sends the header again. Paging to the end without an error in step 13 is the evidence
    that is enough. Write "ok" or the failing status.

### E. OV-C4: owners, members and the second page (U68, U71), 4 minutes

15. Open a Microsoft 365 group with owners and members. Expected: the sections **Owners** and **Members**
    each list rows with name and e-mail address; the page says "Only direct members are listed." **U71:** a
    dash in the name or e-mail column of every user row means Microsoft did not return the requested
    properties on that list; write down which column.
16. **U68:** the **Owners** section lists the owners without the message "The owners could not be loaded". If
    that message appears, open the Network tab, click the failed `owners` request and write down status
    and `code`: it means Microsoft refuses owners to an application with `GroupMember.Read.All`.
17. Open a mail-enabled security group or a distribution list. Expected: "Owners are not available for this
    kind of group." (the owners of such groups are not available in Microsoft Graph). If owners are listed
    instead, write that down: it is better than expected.
18. Open the group with more than 100 members. The members table shows 50 per page: click "Next page" until
    it is gone. In the Console copy nothing from the address bar into your notes; run
    `await count('/api/v1/groups/' + location.pathname.split('/').pop() + '/members')` while that group is
    open and compare the number with the **direct** member count in the Entra admin center. Expected: equal.

### F. OV-C5: hidden membership and a user's groups (U67, U74), 3 minutes

19. In **Groups** (all types), find a group whose "Visibility" says "Hidden membership" and open it.
    Expected exactly: "The membership of this group is hidden." under Members, and the Owners section
    still lists the owners. (The panel does not ask Microsoft for those members; it does not hold the
    permission `Member.Read.Hidden` and does not request it.) No such group: write "not tested".
20. Open a user who is a member of that group (look it up in Entra). In **Group memberships** note **whether
    that group is in the list** (yes or no). That answers the second half of **U67**. The page always says
    that the list includes groups through other groups and that hidden-membership groups may be missing.
21. **U74:** in the same list every group should have a name and a type. A dash for the name, or the type
    "Unknown", means `transitiveMemberOf` returns only limited information for some groups. Write down how
    many rows of how many.

### G. OV-C6: scope and restricted rows (FR-C-203, FR-C-307, FR-C-205), 5 minutes

The next steps give D the role *Reader* **limited to the users of department X** and nothing else. The
panel has no assignment screen yet (Phase D), so you use the browser console as in the Phase B sheet (step 25).

22. As G open `http://localhost:9300/auth/login?purpose=stepup&returnTo=/settings/access` (your own address
    if different) and sign in again (step-up). In the Console of that tab:

    ```js
    const {token} = await (await fetch('/api/v1/csrf')).json();
    const send = (method, path, body) => fetch(path, {method, headers:{...(body ? {'content-type':'application/json'} : {}), 'x-csrf-token':token}, body: body && JSON.stringify(body)}).then(async r => [r.status, r.status < 300 && r.status !== 204 ? (await r.json()).id : undefined]);
    await send('POST','/api/v1/rbac/assignments',{principalType:'user',principalId:'<object id of D>',role:'reader',scope:[{target:'user',match:{by:'department',value:'<department X>'}}]})
    ```

    Expect `[201, "<assignment id>"]`; keep that assignment id in your notes for the clean-up (step 28).
23. In a private browser window sign in as D. Open **Users**. Expected: **only** users of department X
    (the Department column; run `await count('/api/v1/users')` and compare with the number of users of X in
    Entra). The list may show fewer than 50 rows, or none, together with an active "Next page": the panel
    reads at most five Microsoft pages per request. Keep pressing "Next page" until the button is gone: the
    page must never fill with users of another department. **Fail:** any row of another department.
24. Take the id of a user **outside** X from the Entra admin center (do not write it down), and in the
    Console of D's window run `(await fetch('/api/v1/users/<that id>')).status`. Expected **403**; the page
    `/users/<that id>` shows an error, not the data. A made-up id in GUID form must answer **404**, not 403.
25. As D open **Groups** (D sees all groups) and then a group with members from several departments.
    Expected: members of X are shown with name; every other member is a row "Restricted"; above the table
    "n members you cannot see"; no name, e-mail address or id appears for a restricted row (Network tab: such
    a row is only `{ "kind": "user", "restricted": true }`). **U71/deviation:** if **every** member is
    restricted although some are in X, Microsoft does not return `department` on the members list; report
    it. If the manager of a user of X is outside X (and outcome A or C of step 11) the manager shows
    "Restricted".
26. **Basic access (`users:read` with the qualifier basic):** this half **cannot be done** on a real
    installation in Phase C. The role template *Bestuur* is not assignable until Phase D and the API has no
    call that creates a custom role, so there is no supported way to make such an actor. Answer **Not
    tested** for this half; the automated tests cover it (list shows id, name and e-mail only, the
    state and type filters answer 422 `filter_not_allowed`, the detail has no manager and no groups).
27. Sign D out and close the private window.

### H. Clean up and report back (2 minutes)

28. As G, with a fresh step-up as in step 22, delete D's assignment:
    `await send('DELETE','/api/v1/rbac/assignments/<assignment id>')` (expect `[204, undefined]`). Check that
    D now has no access (sign-in ends on the "no access" page).
29. Restore anything else you changed. Nothing else in the tenant was written by this test; the panel
    itself writes nothing in Phase C.

#### What to report back

Answer in this form, one line per check. Allowed content: a result word, numbers, milliseconds, HTTP status
codes, the `code` of an error (for example `graph_unavailable`, `cursor_invalid`, `permission_denied`), and
the words of the outcomes above. **Not allowed:** names, addresses, any id, tokens, cookies, secrets,
certificates, device codes, or screenshots that show any of them.

| OV | Result (Pass, Fail, Not tested) | Facts to report |
|---|---|---|
| OV-C1 (steps 3 to 9) | | The status and `code` of any failed list call (U70). Counts from Entra and from the panel: disabled, guests, members, all users, and members plus guests against all (U72). Counts of the four group kinds from the panel and from Entra or Exchange, and how many groups are `unknown` (U36, U69). Which group fields are a dash for every group (U69). |
| OV-C2 (steps 10 and 11) | | Outcome A, B or C (U66), for how many of how many users with a manager, and the number from the `grep -c` line. |
| OV-C3 (steps 12 to 14) | | The two times in milliseconds, number of users counted against Entra, whether paging to the end worked, whether the tenant has more than 100 and more than 999 users (SC-C4, U73). |
| OV-C4 (steps 15 to 18) | | Whether owners and members showed name and e-mail (U71); the failed `owners` status and `code` if any (U68); whether a distribution list showed "not available"; the member count of the large group against Entra. |
| OV-C5 (steps 19 to 21) | | Whether the hidden-membership text appeared; whether the user's list contained the hidden group (U67); how many rows with a dash or type "Unknown" out of how many (U74). |
| OV-C6 (steps 22 to 27) | | Only X users in D's list (yes or no); the status of an outside user (403 expected) and of a made-up id (404 expected); whether other members were "Restricted"; whether members of X were shown in full (U71 deviation); "Not tested" for basic. |

If a check shows something you cannot explain, say what you saw in words and stop; do not retry in a way
that changes data. The questions that follow from your answers (keep the manager as best effort or drop it,
request `Member.Read.Hidden` or not, drop the `or` in the user search) are decisions ODC-04, ODC-05 and
fallbacks of U70 in the phase report.

## Nederlands

### Hoe lang, en wat je nodig hebt

Ongeveer **30 minuten** voor de controles (A 3, B 6, C 3, D 4, E 4, F 3, G 5, rapporteren en opruimen 2
minuten), plus eenmalig de tijd om testgegevens klaar te zetten. Het paneel blijft werken, wat de
antwoorden ook zijn: elke onbevestigde claim heeft een ontworpen terugvaloptie (een melding, nooit een
foutpagina). Een "mislukt" hieronder is dus informatie voor de volgende versie, geen kapotte installatie.

Je hebt nodig:

- het paneel met de build van Fase C, verbonden met een testtenant (de stappen A tot en met F van het
  Fase B-blad in [phase-B.md](phase-reports/phase-B.md) zijn gedaan) en je kunt aanmelden als **G**, de
  Eigenaar. Fase C verandert geen uitrolbestand: geen nieuwe variabele, geen Compose-regel, geen migratie.
  Haal de nieuwe image op, herstart de container en meld opnieuw aan. (Een herstart beëindigt ook alle
  lijstcursors; dat is zo ontworpen.)
- **D**, een testgebruiker die nog **geen** paneelrol heeft (OV-C6).
- Gegevens in de tenant, eenmalig op te zoeken in het Entra-beheercentrum (https://entra.microsoft.com):
  gebruikers met en zonder manager; minstens één uitgeschakelde gebruiker, één gast en gebruikers in minstens
  twee afdelingen, waarvan één (noem hem **X**) 2 tot 20 gebruikers heeft; een Microsoft 365-groep met
  eigenaren; een groep met **meer dan 100 directe leden** (OV-C4); een beveiligingsgroep; een
  e-mailbeveiligingsgroep en een distributielijst (Exchange-beheercentrum,
  https://admin.exchange.microsoft.com); en, als je er een kunt maken of vinden, een groep met **verborgen
  lidmaatschap** (OV-C5). Meer dan 100 gebruikers maakt de pagineringscontrole zinvol (D), meer dan 999
  gebruikers maakt hem volledig. Wat ontbreekt, beantwoord je met "niet getest".
- Een Chromium- of Firefox-browser. Open de ontwikkelaarstools (F12), tabblad **Netwerk** (Network), en houd
  een tekstbestand voor aantekeningen bij. In het tabblad **Console** vraagt Chrome je eenmalig
  `allow pasting` te typen voordat geplakte code wordt geaccepteerd.

**Lees dit eerst: wat je mag overnemen.** Het paneel toont echte namen en adressen op het scherm en in het
netwerktabblad. Dat is alleen voor jouw ogen. Schrijf in je aantekeningen en in wat je terugstuurt getallen,
woorden als "aanwezig", "niet beschikbaar" of "beperkt", HTTP-statuscodes en foutcodes. Neem nooit een
naam, een e-mailadres, een gebruikersprincipalnaam, een object-, tenant- of applicatie-id over (ook niet uit
de adresbalk), een cookie, een token, de `APP_KEY`, het setup-token, een certificaat, een apparaatcode of een
schermafbeelding waarop dit staat.

### A. Voorbereiden (3 minuten)

1. Meld aan als G. Open Instellingen, **Verbinding**, bewijslijst, "Microsoft Graph-rechten": de verleende
   rollen bevatten `User.Read.All` en `GroupMember.Read.All`. Fase C vraagt Microsoft om **geen nieuw
   recht**, dus er mag in deze test nergens een toestemmingsscherm verschijnen; gebeurt dat toch, stop en
   meld het.
2. Open in de ontwikkelaarstools de **Console** en plak deze drie hulpfuncties (ze tonen alleen getallen,
   nooit namen):

   ```js
   async function count(path){let n=0,c;do{const u=new URL(path,location.origin);u.searchParams.set('limit','200');if(c)u.searchParams.set('cursor',c);const r=await fetch(u);if(!r.ok)return 'HTTP '+r.status;const j=await r.json();n+=j.items.length;c=j.nextCursor}while(c);return n}
   async function tally(path){const t={};let c;do{const u=new URL(path,location.origin);u.searchParams.set('limit','200');if(c)u.searchParams.set('cursor',c);const r=await fetch(u);if(!r.ok)return 'HTTP '+r.status;const j=await r.json();for(const i of j.items){const k=i.kind??'?';t[k]=(t[k]||0)+1}c=j.nextCursor}while(c);return t}
   async function timeIt(path){const t=performance.now();const r=await fetch(path);const j=await r.json();return [r.status,(j.items||[]).length,Math.round(performance.now()-t)+' ms']}
   ```

   `count('/api/v1/users')` loopt de hele lijst door en geeft terug hoeveel gebruikers erin staan (het
   paneel zelf toont nergens een totaal). Het stopt met `HTTP <status>` als een aanroep mislukt.

### B. OV-C1: zoeken, filters, volgorde, soorten (U69, U70, U72, U36), 6 minuten

3. Open **Gebruikers**. Verwacht: een tabel met hoogstens 50 rijen, de regel "50 gebruikers getoond" (of
   minder) en een knop "Volgende pagina" als er meer zijn. Typ `a` bij "Zoek op naam of e-mailadres" en kies
   "Zoeken". Verwacht: alleen rijen waarvan naam, e-mailadres of principalnaam **begint** met "a" (het is een
   voorvoegselzoekopdracht, geen woordzoeker) of "Geen gebruikers gevonden". **Mislukt (U70):** de melding "De
   gebruikers konden niet worden geladen". Open dan het netwerktabblad, klik op het mislukte `users`-verzoek
   en noteer alleen de status en de `code` in het antwoord.
4. Kies "Uitgeschakeld" bij "Accountstatus": elke rij toont Status "Uitgeschakeld". Voer in de Console uit
   `await count('/api/v1/users?enabled=false')` en vergelijk het getal met de uitgeschakelde accounts die je
   uit het Entra-beheercentrum kent. Noteer beide getallen.
5. Kies "Gasten" bij "Soort gebruiker" (accountstatus terug op "Alle accounts"): elke rij toont Soort "Gast".
   Voer uit `await count('/api/v1/users?type=guest')`, `await count('/api/v1/users?type=member')` en
   `await count('/api/v1/users')`. Noteer de drie getallen en de aantallen leden en gasten uit het
   Entra-beheercentrum. **U72:** als leden plus gasten minder is dan alle gebruikers, bestaan er gebruikers
   zonder type (zij staan ontworpen in geen van beide filters); noteer het verschil.
6. Klik op de kop "Weergavenaam": de volgorde keert om (namen van Z naar A) en de sorteerknop toont de
   volgorde. Combineer dan: zoek `a`, "Uitgeschakeld", aflopend. Verwacht: een lijst of "Geen gebruikers
   gevonden", **geen fout**. Dit is de combinatie van U70 (voorvoegselzoekopdracht met `or`, twee filters en
   een volgorde).
7. Open **Groepen**. Kies na elkaar elk soort: "Microsoft 365", "Beveiliging", "E-mailbeveiliging",
   "Distributie". Elke rij heeft dat soort; de laatste twee tonen ook het label "Alleen lezen"; bij
   "Distributie" staat een opmerking dat dynamische distributielijsten in Exchange worden beheerd en hier niet
   staan (Microsoft geeft ze niet terug). Voer in de Console uit `await count('/api/v1/groups?kind=m365')`,
   hetzelfde voor `security`, `mailsecurity`, `distribution`, en `await tally('/api/v1/groups')`. Vergelijk
   de vier aantallen met het Entra- en het Exchange-beheercentrum (welke weergave je gebruikte verschilt per
   portalversie: noteer het). Een verschil van één of twee kan een wijziging van de laatste minuten zijn.
8. Kijk in de telling naar `unknown`. **U36/U69:** een groep van het soort "Onbekend" betekent dat Microsoft
   `groupTypes`, `mailEnabled` of `securityEnabled` niet teruggaf; noteer hoeveel van het totaal.
9. Open een groep van elk soort. Verwacht: Soort, "E-mailalias", "Beschrijving", "Zichtbaarheid" en
   "Lidmaatschap" (Toegewezen of Dynamisch) zijn gevuld waar de groep ze heeft. **U69:** staat bij
   "Zichtbaarheid", "E-mailalias" of "Beschrijving" bij **elke** groep een streepje, dan geeft Microsoft die
   eigenschap niet aan het paneel; noteer welke velden.

### C. OV-C2: de manager (U66), 3 minuten

10. Open een gebruiker met een manager (uit Entra) en lees het blok **Manager**. Open dan een gebruiker
    zonder manager. Herhaal dit voor drie gebruikers met een manager.
11. Verwacht, een van drie uitkomsten, alle drie zijn acceptabel:
    - **A (U66 werkt):** de manager staat er voor gebruikers die er een hebben, en "Geen manager" bij de
      gebruiker zonder;
    - **B (U66 geweigerd):** bij elke gebruiker met een manager staat "Manager niet beschikbaar", bij die
      zonder staat "Geen manager". Dit is wat de Learn-pagina voor applicatierechten voorspelt;
    - **C (gemengd):** sommige gebruikers tonen een manager en sommige "Manager niet beschikbaar". Noteer
      wat ze gemeen hebben als je dat kunt zien (zonder namen).

    Bij A en B moet de rest van de gebruikerspagina werken (eigenschappen, groepslidmaatschappen). Voer uit
    `docker logs m365portal 2>&1 | grep -c directory_manager_unavailable` en noteer het getal (de logregel
    bevat geen naam of id).

### D. OV-C3: snelheid en pagineren tot het einde (SC-C4, U73), 4 minuten

12. Voer in de Console twee keer uit `await timeIt('/api/v1/users?limit=100')`. Verwacht: `200`, `100`
    (minder bij minder gebruikers) en een tijd. Noteer beide tijden in milliseconden. De eerste aanroep
    bevat het eerste token en het vullen van de cache, de tweede is de warme. (De 300 ms uit de spec geldt
    voor de gesimuleerde tenant; de jouwe hangt van Microsoft af. Het is een meting, geen slaagcijfer.)
13. Voer uit `await count('/api/v1/users')` en vergelijk met het aantal gebruikers in het
    Entra-beheercentrum (wijzigingen van enkele seconden daargelaten). Verwacht: een getal, geen
    `HTTP`-tekst. Klik op de pagina **Gebruikers** drie keer op "Volgende pagina" en één keer op "Vorige
    pagina": geen rij komt twee keer voor, geen fout, de paginatekst volgt ("Pagina 2"). Bij meer dan 100
    gebruikers volgt dit de `nextLink` van Microsoft; bij meer dan 999 gebruikers loopt het over een volle
    Microsoft-pagina.
14. **U73** (blijft een `nextLink` werken zonder de header `ConsistencyLevel`) vraagt geen handeling: het
    paneel stuurt de header altijd opnieuw mee. Pagineren tot het einde zonder fout in stap 13 is genoeg
    bewijs. Noteer "ok" of de mislukte status.

### E. OV-C4: eigenaren, leden en de tweede pagina (U68, U71), 4 minuten

15. Open een Microsoft 365-groep met eigenaren en leden. Verwacht: de blokken **Eigenaren** en **Leden**
    tonen elk rijen met naam en e-mailadres; de pagina zegt "Alleen directe leden worden getoond." **U71:**
    een streepje in de kolom naam of e-mail bij elke gebruikersrij betekent dat Microsoft de gevraagde
    eigenschappen op die lijst niet teruggaf; noteer welke kolom.
16. **U68:** het blok **Eigenaren** toont de eigenaren zonder de melding "De eigenaren konden niet worden
    geladen". Verschijnt die melding, open dan het netwerktabblad, klik op het mislukte `owners`-verzoek en
    noteer status en `code`: Microsoft weigert dan eigenaren aan een applicatie met `GroupMember.Read.All`.
17. Open een e-mailbeveiligingsgroep of een distributielijst. Verwacht: "Eigenaren zijn niet beschikbaar voor
    dit soort groep." (Microsoft Graph heeft voor zulke groepen geen eigenaren). Staan er wel eigenaren,
    noteer dat: het is beter dan verwacht.
18. Open de groep met meer dan 100 leden. De ledentabel toont 50 per pagina: klik op "Volgende pagina" tot
    de knop weg is. Neem niets uit de adresbalk over in je aantekeningen; voer uit
    `await count('/api/v1/groups/' + location.pathname.split('/').pop() + '/members')` terwijl die groep
    open staat en vergelijk het getal met het aantal **directe** leden in het Entra-beheercentrum. Verwacht:
    gelijk.

### F. OV-C5: verborgen lidmaatschap en de groepen van een gebruiker (U67, U74), 3 minuten

19. Zoek bij **Groepen** (alle soorten) een groep met bij "Zichtbaarheid" de tekst "Verborgen lidmaatschap" en
    open hem. Verwacht precies: "Het lidmaatschap van deze groep is verborgen." onder Leden, en het blok
    Eigenaren toont de eigenaren nog wel. (Het paneel vraagt Microsoft niet om die leden; het heeft het recht
    `Member.Read.Hidden` niet en vraagt het niet aan.) Geen zo'n groep: schrijf "niet getest".
20. Open een gebruiker die lid is van die groep (zoek op in Entra). Noteer bij **Groepslidmaatschappen**
    **of die groep in de lijst staat** (ja of nee). Dat beantwoordt de tweede helft van **U67**. De pagina
    zegt altijd dat de lijst ook groepen via andere groepen bevat en dat groepen met verborgen lidmaatschap
    kunnen ontbreken.
21. **U74:** in dezelfde lijst hoort elke groep een naam en een soort te hebben. Een streepje bij de naam,
    of het soort "Onbekend", betekent dat `transitiveMemberOf` voor sommige groepen maar beperkte informatie
    geeft. Noteer hoeveel rijen van hoeveel.

### G. OV-C6: scope en beperkte rijen (FR-C-203, FR-C-307, FR-C-205), 5 minuten

De volgende stappen geven D de rol *Lezer* **beperkt tot de gebruikers van afdeling X** en niets anders. Het
paneel heeft nog geen scherm voor toewijzingen (Fase D), dus gebruik je de browserconsole zoals in het
Fase B-blad (stap 25).

22. Open als G `http://localhost:9300/auth/login?purpose=stepup&returnTo=/settings/access` (je eigen adres
    als dat anders is) en meld opnieuw aan (step-up). In de Console van dat tabblad:

    ```js
    const {token} = await (await fetch('/api/v1/csrf')).json();
    const send = (method, path, body) => fetch(path, {method, headers:{...(body ? {'content-type':'application/json'} : {}), 'x-csrf-token':token}, body: body && JSON.stringify(body)}).then(async r => [r.status, r.status < 300 && r.status !== 204 ? (await r.json()).id : undefined]);
    await send('POST','/api/v1/rbac/assignments',{principalType:'user',principalId:'<object-id van D>',role:'reader',scope:[{target:'user',match:{by:'department',value:'<afdeling X>'}}]})
    ```

    Verwacht `[201, "<toewijzings-id>"]`; bewaar dat toewijzings-id in je aantekeningen voor het opruimen
    (stap 28).
23. Meld in een privévenster aan als D. Open **Gebruikers**. Verwacht: **alleen** gebruikers van afdeling X
    (kolom Afdeling; voer uit `await count('/api/v1/users')` en vergelijk met het aantal gebruikers van X in
    Entra). De lijst kan minder dan 50 rijen tonen, of geen, met een actieve knop "Volgende pagina": het
    paneel leest per verzoek hoogstens vijf Microsoft-pagina's. Blijf op "Volgende pagina" drukken tot de
    knop weg is: de pagina mag nooit gebruikers van een andere afdeling tonen. **Mislukt:** elke rij van een
    andere afdeling.
24. Neem uit het Entra-beheercentrum het id van een gebruiker **buiten** X (schrijf het niet op) en voer in
    de Console van het venster van D uit `(await fetch('/api/v1/users/<dat id>')).status`. Verwacht **403**;
    de pagina `/users/<dat id>` toont een fout, niet de gegevens. Een verzonnen id in GUID-vorm moet **404**
    geven, geen 403.
25. Open als D **Groepen** (D ziet alle groepen) en dan een groep met leden uit meerdere afdelingen.
    Verwacht: leden van X staan met naam; elk ander lid is een rij "Beperkt"; boven de tabel staat "n leden
    die u niet kunt zien"; voor een beperkte rij verschijnt geen naam, e-mailadres of id (netwerktabblad:
    zo'n rij is alleen `{ "kind": "user", "restricted": true }`). **U71/afwijking:** als **elk** lid beperkt
    is terwijl sommige in X zitten, geeft Microsoft `department` niet op de ledenlijst; meld het. Staat de
    manager van een gebruiker van X buiten X (en uitkomst A of C van stap 11), dan toont de manager
    "Beperkt".
26. **Basistoegang (`users:read` met kwalificatie basic):** deze helft **kan** in Fase C op een echte
    installatie **niet**. Het sjabloon *Bestuur* is pas in Fase D toewijsbaar en de API heeft geen aanroep
    die een eigen rol maakt, dus er is geen ondersteunde manier om zo'n aanvrager te maken. Antwoord **Niet
    getest** voor deze helft; de geautomatiseerde tests dekken het (lijst toont alleen id, naam en e-mail, de
    filters op status en soort geven 422 `filter_not_allowed`, de detailpagina heeft geen manager en geen
    groepen).
27. Meld D af en sluit het privévenster.

### H. Opruimen en terugmelden (2 minuten)

28. Verwijder als G, met een verse step-up zoals in stap 22, de toewijzing van D:
    `await send('DELETE','/api/v1/rbac/assignments/<toewijzings-id>')` (verwacht `[204, undefined]`).
    Controleer dat D geen toegang meer heeft (aanmelden eindigt op de pagina "geen toegang").
29. Zet al het andere terug wat je veranderde. Deze test schrijft verder niets in de tenant; het paneel zelf
    schrijft in Fase C niets.

#### Wat je terugmeldt

Antwoord in deze vorm, één regel per controle. Toegestaan: een resultaatwoord, getallen, milliseconden,
HTTP-statuscodes, de `code` van een fout (bijvoorbeeld `graph_unavailable`, `cursor_invalid`,
`permission_denied`) en de woorden van de uitkomsten hierboven. **Niet toegestaan:** namen, adressen, welk
id dan ook, tokens, cookies, geheimen, certificaten, apparaatcodes of schermafbeeldingen waarop dit staat.

| OV | Resultaat (Geslaagd, Mislukt, Niet getest) | Feiten om terug te melden |
|---|---|---|
| OV-C1 (stap 3 tot 9) | | Status en `code` van een mislukte lijstaanroep (U70). Aantallen uit Entra en uit het paneel: uitgeschakeld, gasten, leden, alle gebruikers, en leden plus gasten tegenover alle (U72). Aantallen van de vier groepssoorten uit het paneel en uit Entra of Exchange, en hoeveel groepen `unknown` zijn (U36, U69). Welke groepsvelden bij elke groep een streepje zijn (U69). |
| OV-C2 (stap 10 en 11) | | Uitkomst A, B of C (U66), bij hoeveel van hoeveel gebruikers met een manager, en het getal van de `grep -c`-regel. |
| OV-C3 (stap 12 tot 14) | | De twee tijden in milliseconden, het getelde aantal gebruikers tegenover Entra, of pagineren tot het einde werkte, en of de tenant meer dan 100 en meer dan 999 gebruikers heeft (SC-C4, U73). |
| OV-C4 (stap 15 tot 18) | | Of eigenaren en leden naam en e-mail toonden (U71); status en `code` van een mislukte `owners`-aanroep (U68); of een distributielijst "niet beschikbaar" toonde; het ledenaantal van de grote groep tegenover Entra. |
| OV-C5 (stap 19 tot 21) | | Of de tekst over verborgen lidmaatschap verscheen; of de lijst van de gebruiker de verborgen groep bevatte (U67); hoeveel rijen met een streepje of het soort "Onbekend" van hoeveel (U74). |
| OV-C6 (stap 22 tot 27) | | Alleen X-gebruikers in de lijst van D (ja of nee); de status voor een gebruiker buiten X (403 verwacht) en voor een verzonnen id (404 verwacht); of andere leden "Beperkt" waren; of leden van X volledig getoond werden (U71-afwijking); "Niet getest" voor basic. |

Zie je iets dat je niet kunt verklaren, beschrijf dan in woorden wat je zag en stop; probeer het niet opnieuw
op een manier die gegevens verandert. De vragen die uit je antwoorden volgen (de manager als bonus houden of
laten vallen, `Member.Read.Hidden` wel of niet aanvragen, de `or` in de gebruikerszoekopdracht laten vallen)
zijn de besluiten ODC-04 en ODC-05 en de terugvalopties van U70 in het fase-rapport.
