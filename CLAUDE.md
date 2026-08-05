# Guest Suite Tracker — Claude Code Context

## What This App Is
Booking calendar and nightly-rate tracker for Buckingham's guest suites (starting
with The Beverly). Okta-authenticated, Azure SQL-backed. See `infra/README.md` for
the original pre-deployment provisioning plan — this file is the as-built record of
what actually happened during deployment, including the platform quirks that
differed from that plan.

**Status as of 2026-08-01:** deployed and functionally working end-to-end (login,
SQL, calendar, rates, bookings, reports). Smoke-tested by Shane Wells using a
temporary admin group membership (since removed). **Still needs a full smoke test
by an actual `GuestSuites-Admin` and a genuine `GuestSuites-Staff`-only user** — see
"What Still Needs Testing" below.

## File Structure
```
frontend/    — Static Web App content (index.html, app.js, styles.css, staticwebapp.config.json)
api/         — Azure Functions v4 backend (src/functions/*.js, src/shared/*.js)
database/    — schema.sql, views.sql, seed_beverly.sql (run in that order)
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

## Okta Setup
- OIDC Web App integration, "Guest Suite Tracker", Authorization Code flow.
  - `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET` are stored as **plain values** in
    `swa-guestsuites`'s Environment Variables (Key Vault reference doesn't resolve
    here — see quirk #1).
  - Sign-in redirect: `.../.auth/login/okta/callback`
  - Sign-out redirect: `.../.auth/logout/okta/callback`
  - `login.scopes` in `frontend/staticwebapp.config.json` **must include `"groups"`**
    — see quirk #4.
  - Groups claim is configured on the app integration's own **Sign On** tab
    ("Group Claims" / legacy section), filtered to `GuestSuites-.*` — not on a
    Custom Authorization Server, because this Okta org doesn't have one (no API
    Access Management add-on).
- **Groups**: `GuestSuites-Admin`, `GuestSuites-Staff` — membership is **dynamic**
  via Okta Group Rules based on the `YardiNumber` and `title` profile attributes,
  not manual assignment:
  - Admin rule: `String.stringContains(user.title, "Manager") && String.stringContains(user.YardiNumber, "1271")`
  - Staff rule: `String.stringContains(user.YardiNumber, "1271")`
  - `1271` is The Beverly's Yardi property code. Adding another property means
    adding that property's code to these rules (see "Adding Another Property"
    below) — no app code changes needed.
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

## Adding Another Property (e.g. Foundry)
1. Insert rows into `Properties`/`Units` following the pattern in
   `database/seed_beverly.sql`.
2. Add that property's Yardi code to both Okta group rules above (currently
   hardcoded to `1271`).
3. No app code changes needed — the property selector and calendar pick it up
   automatically.
