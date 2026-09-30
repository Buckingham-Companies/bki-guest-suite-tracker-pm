# Guest Suite Tracker — Claude Code Context

## What This App Is
Booking calendar and nightly-rate tracker for Buckingham's guest suites, covering
multiple properties (The Beverly, Portrait Midtown, and growing). Okta-authenticated,
Azure SQL-backed. See `infra/README.md` for the original pre-deployment provisioning
plan — this file is the as-built record of what actually happened during deployment,
including the platform quirks that differed from that plan.

**Status as of 2026-08-01:** deployed and functionally working end-to-end (login,
SQL, calendar, rates, bookings, reports) for the original single-property (Beverly)
version. Smoke-tested by Shane Wells using a temporary admin group membership (since
removed). **Still needs a full smoke test by an actual `GuestSuites-Admin` and a
genuine `GuestSuites-Staff`-only user** — see "What Still Needs Testing" below.

**In progress as of 2026-09-14:** reworking property access from "one Okta group per
app, single implicit property" to attribute-based, multi-property access — see
"Multi-Property Access Model" below. Portrait Midtown (Yardi #1264, Unit 301) added
as the second property. This needs an Okta-side change from IT (Shane Wells) before
it works end-to-end — see "Okta Setup" below.

## File Structure
```
frontend/    — Static Web App content (index.html, app.js, styles.css, staticwebapp.config.json)
api/         — Azure Functions v4 backend (src/functions/*.js, src/shared/*.js)
database/    — schema.sql, views.sql (run first, in that order), then one
               seed_<property>.sql per property (any order, each self-contained)
infra/       — README.md: original provisioning plan (Rebecca Dodge, pre-deployment)
```

## Azure Resources (as actually provisioned)
- **Resource Group**: `rg-app-guestsuites` (Central US)
- **Azure SQL**: server `sql-app-guestsuites`, database `GuestSuites`, Basic tier,
  locally-redundant backups.
  - Auth: SQL login `guestsuites_app` (db_datareader/db_datawriter only) — **not**
    managed identity. See Known Platform Quirks #2.
- **Static Web App**: `swa-guestsuites` (Standard plan), linked to this repo's
  `main` branch, `app_location=/frontend`, `api_location=/api`.
  - URL: `https://gray-coast-01347a010.7.azurestaticapps.net`
  - Deploys automatically on push to `main` via the auto-generated GitHub Actions
    workflow (`.github/workflows/azure-static-web-apps-gray-coast-01347a010.yml`).
- **Key Vault**: `kv-guestsuites` — holds a backup copy of the Okta client secret.
  **Not actively used for injection** — see Known Platform Quirks #1.

## Multi-Property Access Model
As of 2026-09, property access is **attribute-based**, not group-based-per-property.
The two pieces:

1. **App assignment / coarse role** (Okta groups, unchanged mechanism from the
   original single-property design — see "Okta Setup" below): `GuestSuites-Staff`
   lets someone log in at all; `GuestSuites-Admin` additionally grants the `admin`
   SWA role, which gates the rate-writing routes at the platform level
   (`staticwebapp.config.json` `allowedRoles`). Neither group is property-specific
   anymore — see the new rules below.
2. **Property scoping** (which properties someone actually sees/can write to):
   driven entirely by the `user.YardiNumber` Okta profile attribute (see Shane
   Wells' Teams message, 2026-09-12 — official Okta attribute name is
   `user.YardiNumber`, commonly called just "YardiNumber"), matched against
   `Properties.YardiNumber` in the database. A Property Manager has one Yardi
   number and sees one property; a VP/Regional/Multi-Site Manager has several and
   sees all of them. This is enforced **server-side, per request**, in
   `api/src/shared/auth.js` (`requirePropertyAccess` / `requireUnitAccess`) —
   never trust the frontend's property dropdown as the security boundary.

This means adding a property is a database-only change (see "Adding Another
Property" below) — **no Okta group-rule edit is needed per property**, which is
the whole point of the redesign (Rebecca Dodge, 2026-09-14): the old model required
editing both group rules' hardcoded Yardi-code list every time a property was
added, which doesn't scale.

**Where the YardiNumber claim has to reach:** Okta ID token → SWA's
`x-ms-client-principal` header → `principal.claims` → `auth.js`'s `getUser()`. This
is the same `claims` array shape already used in the `POST /api/getRoles` body (see
quirk below about `/.auth/me`) — it needs `YardiNumber` (and `title`, for the Admin
group rule) added as claims on the app integration's Sign On tab, the same place
`groups` already is. **Not yet confirmed with IT whether Okta will send multiple
Yardi numbers as a true multi-value claim or a single delimited string** — `auth.js`
parses either, so no code change is needed once that's settled, but verify via
`/.auth/me` after Shane adds the claim (same way quirk #4 below was originally
caught).

## Okta Setup
- OIDC Web App integration, "Guest Suite Tracker", Authorization Code flow.
  - `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET` are stored as **plain values** in
    `swa-guestsuites`'s Environment Variables (Key Vault reference doesn't resolve
    here — see quirk #1).
  - Sign-in redirect: `.../.auth/login/okta/callback`
  - Sign-out redirect: `.../.auth/logout/okta/callback`
  - `login.scopes` in `frontend/staticwebapp.config.json` **must include `"groups"`**
    — see quirk #4. Verify whether `YardiNumber`/`title` need their own scope too
    once IT adds them as claims (unconfirmed — this org has no Custom Authorization
    Server, so it may just be a Sign On tab claims-mapping addition like `groups`,
    with no scope change needed. Check via `/.auth/me`).
  - Groups claim is configured on the app integration's own **Sign On** tab
    ("Group Claims" / legacy section), filtered to `GuestSuites-.*` — not on a
    Custom Authorization Server, because this Okta org doesn't have one (no API
    Access Management add-on). **`YardiNumber` and `title` need to be added as
    claims in this same place** (Shane Wells is setting this up — see his Teams
    screenshot, 2026-09-12: Display name "Yardi Number", Variable name
    `user.YardiNumber`).
- **Groups**: `GuestSuites-Admin`, `GuestSuites-Staff` — membership is **dynamic**
  via Okta Group Rules, redefined 2026-09 to drop the old per-property Yardi-code
  hardcoding now that property scoping happens in-app (see "Multi-Property Access
  Model" above):
  - Staff rule (**new**): `String.isNotEmpty(user.YardiNumber)` — anyone assigned to
    at least one Yardi property can log in. Which properties they can *see* is
    decided by the app, not this rule.
  - Admin rule (**new**): `String.stringContains(user.title, "Manager") || String.stringContains(user.title, "VP") || String.stringContains(user.title, "Regional") || String.stringContains(user.title, "District")`
    — no site restriction; a qualifying title grants Admin (rate-setting) at
    *every* property in that person's own YardiNumber list, enforced by
    `requireUnitAccess` in the API, not by this rule. (Decision: Rebecca Dodge,
    2026-09-14 — deliberately broader than the original Beverly-only "Manager"-only
    rule, to cover VP/Regional/District roles overseeing multiple sites.)
  - Old rules, for reference (Beverly-only, retired 2026-09):
    `String.stringContains(user.title, "Manager") && String.stringContains(user.YardiNumber, "1271")`
    (Admin) and `String.stringContains(user.YardiNumber, "1271")` (Staff).
- **Companion Bookmark App**: a second Okta app integration ("Guest Suite Tracker",
  Bookmark type, pointed at the SWA URL) was created and assigned to the same two
  groups. This exists because the real OIDC app is configured "Login initiated by:
  App Only" (SP-initiated only) and therefore doesn't get a dashboard tile on its
  own — the bookmark just opens the URL, and the app's own SP-initiated flow
  completes silently against the user's existing Okta session.
- **App logo**: uploaded — Okta's tile spec is a **420×120 PNG, transparent
  background** (landscape, not square). Keep this spec handy if anyone wants to
  swap the branding later.

## Known Platform Quirks (found the hard way during this deployment — don't redo this work)
1. **Key Vault references don't resolve** for the Functions API that Azure Static
   Web Apps links/manages for you (confirmed via
   [Azure/static-web-apps#1090](https://github.com/Azure/static-web-apps/issues/1090)).
   `OKTA_CLIENT_SECRET` and `SQL_CONNECTION_STRING` are both plain values in the
   SWA's Environment Variables, not `@Microsoft.KeyVault(...)` references.
2. **Managed identity SQL auth doesn't work in this same runtime**, most likely
   the same root cause as #1 (the identity endpoint isn't reachable from this
   sandbox). `SQL_CONNECTION_STRING` uses SQL login auth (`guestsuites_app`)
   instead of `Authentication=Active Directory Default`.
3. **Don't add a custom `routes` entry for `/.auth/*`.** We tried this to fix an
   unrelated redirect loop, and it caused `navigationFallback` to silently serve
   `index.html` for `/.auth/login/okta` instead of invoking Okta at all —
   a full authentication bypass. Reverted immediately. Microsoft's documented
   pattern (a `/*` catch-all with `allowedRoles: ["authenticated"]` plus a
   `responseOverrides` 401 redirect, and nothing else) is correct and sufficient;
   `/.auth/*` is handled specially by the platform without needing an entry.
4. **The `groups` login scope is required**, even though the groups claim itself
   is configured via the app's own Group Claims filter. Dropping `"groups"` from
   `scopes` silently breaks role resolution — `/.auth/me` still returns
   `userRoles: ["authenticated"]` with no error, so this fails quietly rather than
   loudly. Always verify via `/.auth/me` after any auth config change.
5. This Okta org has **no Custom Authorization Servers** (no API Access Management
   add-on) — `Security > API` only shows Tokens/Trusted Origins, not Authorization
   Servers. All claims configuration lives on the individual app integration's
   Sign On tab instead.
6. Okta **Group Rule conditions use a restricted expression grammar**: `&&`/`||`/`!`
   (not the word-based `and`/`or`/`not`), and the function is
   `String.stringContains(str1, str2)` (not `String.contains`).

## What Still Needs Testing
- [ ] Full smoke test as a genuine `GuestSuites-Staff`-only user (not admin) —
      confirm rate toolbar hidden, price field disabled on new bookings, everything
      else works
- [ ] Full smoke test as a genuine `GuestSuites-Admin` user (Marliss or Juliana) —
      set a rate, add a booking, confirm auto-price, audit trail on edit, Reports
      tab reflects the booking
- [ ] Direct Function App URL bypass test (`infra/README.md` section 3, item 5) —
      confirm the API can't be called directly, bypassing the SWA's auth
- [ ] **New, for multi-property:** confirm via `/.auth/me` that `YardiNumber` (and
      `title`) actually arrive as ID token claims once Shane adds them — the app
      fails "closed" (empty property list, not an error) if this claim is missing,
      so a silent misconfiguration looks like "no properties assigned" rather than
      an obvious break. See quirk #4 for how the equivalent `groups` gap was found.
- [ ] Confirm the real shape of a multi-value `YardiNumber` (comma-delimited
      string vs. true multi-value claim) against a genuine multi-site user (a VP,
      Regional, or Multi-Site PM) once one exists in Okta with it populated —
      `auth.js`'s `parseYardiNumbers` is written to handle either, but hasn't been
      tested against a real multi-value case yet.
- [ ] Smoke test a single-property (Beverly-only) Staff/Admin user still sees
      exactly Beverly and nothing else after the group-rule change — i.e. the
      redesign didn't accidentally widen anyone's access.
- [ ] Smoke test a Portrait Midtown user (YardiNumber `1264`) sees only Portrait
      Midtown, not Beverly.
- [ ] Confirm a user with `YardiNumber` covering both properties sees both in the
      property selector and can move between them.

## Adding Another Property (e.g. Foundry)
1. Look up its Yardi Prop # (Property Listing export, column "Yardi Prop #").
2. Add a new `database/seed_<shortcode>.sql` file following
   `database/seed_portrait_midtown.sql` — insert the `Properties` row (with that
   Yardi number), its `Units`, and any known rates.
3. That's it. **No Okta change, no other app code change** — `/api/properties`
   filters by `user.YardiNumber` at request time, so anyone already assigned to
   that Yardi number in Okta sees it immediately, and the frontend's property
   selector/calendar/reports all pick it up automatically. This is the entire
   point of the 2026-09 access-model rework — see "Multi-Property Access Model"
   above.
