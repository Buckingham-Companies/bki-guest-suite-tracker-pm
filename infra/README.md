# Infra / provisioning notes for Shane

This app is code-complete and ready to deploy, but it doesn't provision itself —
here's exactly what needs to exist in Azure + Okta, and in what order.

## 1. Okta (do this first — the app IDs get pasted into Azure config below)

1. Create two Okta groups: `GuestSuites-Admin` and `GuestSuites-Staff`.
   - Put Marliss + the Beverly property manager in `GuestSuites-Admin`.
   - Put everyone else who needs to reserve suites (APMs, leasing, other PMs) in `GuestSuites-Staff`.
2. Create an Okta OIDC app integration (Web app, Authorization Code flow).
   - Sign-in redirect URI: `https://<your-swa-hostname>/.auth/login/okta/callback`
   - Sign-out redirect URI: `https://<your-swa-hostname>/.auth/logout/callback`
3. On the Okta **Authorization Server** used by this app, add a claim named `groups`
   to the ID token, scoped to `openid`, with a filter that matches the two group
   names above (Okta's default "Groups claim" filter type works fine here). Without
   this claim, `api/src/functions/getRoles.js` has nothing to read and everyone stays
   in the default `authenticated` role — i.e. nobody would ever be able to set rates.
4. Note the Okta domain, Client ID, and Client Secret — needed in step 3 below.

## 2. Azure resources

- **Resource group**: whatever naming convention IT already uses for this kind of tool.
- **Azure SQL Database** (Basic/S0 tier is plenty for 3 units × 1 property — bump later
  if Foundry and more properties get added). Run, in order:
  1. `database/schema.sql`
  2. `database/views.sql`
  3. `database/seed_beverly.sql`
- **Azure Key Vault**: one secret, the SQL connection string (`SQL_CONNECTION_STRING`),
  plus the Okta client secret (`OKTA_CLIENT_SECRET`). Reference both from the
  Function App's application settings as Key Vault references — never paste either
  value directly into app settings or source control.
- **Azure Static Web App** (Standard plan — Standard is required for custom OIDC
  providers and the `rolesSource` feature this app uses):
  - Link the `frontend/` folder as the app's static content.
  - Link `api/` as its Functions API (SWA's "bring your own Functions" / linked backend
    option keeps the API on the SWA's own domain so no CORS config is needed and the
    `x-ms-client-principal` header actually reaches the Functions — see the comment in
    `api/src/shared/auth.js`).
  - App settings: `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET` (Key Vault reference),
    `SQL_CONNECTION_STRING` (Key Vault reference).
  - Fill in the real Okta domain in `frontend/staticwebapp.config.json`
    (`wellKnownOpenIdConfiguration`) before deploying.
- **CI/CD**: GitHub Actions, triggered on push to `main` — SWA's own GitHub integration
  scaffolds this automatically when you connect the repo in the Azure portal. No manual
  deploys.

## 3. Smoke test after deploying (the thing this session couldn't run — see root README)

1. Sign in as a `GuestSuites-Staff` user. Confirm the rate toolbar is hidden, and that
   creating a booking auto-fills price from whatever rates are on file (or prompts to
   ask an admin if none are set).
2. Sign in as a `GuestSuites-Admin` user. Set a nightly rate for a date range, confirm
   it shows up on the calendar, confirm a booking's price hint picks it up.
3. Edit a booking, then open it again and confirm the History section shows the edit
   with the correct user and timestamp.
4. Hit the Reports tab, confirm occupancy/revenue numbers move after adding a booking.
5. Directly `curl` an Azure Functions URL (bypassing the SWA domain) for `/api/rates`
   with `POST` — confirm it's rejected. If the Function App is reachable directly
   without going through SWA's auth, lock it down (IP restriction to SWA's outbound
   ranges, or Easy Auth on the Function App itself) so `x-ms-client-principal` can't be
   spoofed by calling the Function App directly.

## 4. Repo naming

This folder is named `bki-propmgmt-guest-suites` as a placeholder — confirm the real
department slug with the Innovation team before creating the actual GitHub repo under
`buckingham-tech`, per the naming convention (`bki-[department]-[tool-name]`).

## Adding another property (e.g. Foundry)

No code change. Insert a row into `Properties` and a few rows into `Units` (copy the
pattern in `database/seed_beverly.sql`). It'll show up in the property selector and
get its own calendar automatically.

## Out of scope for this build (documented, not forgotten)

Shane raised using this as a general amenity-booking replacement for the paid CityWay
tool (dynamic per-property permissions, other amenity types beyond guest suites). That's
a real idea worth a follow-up scoping conversation with Innovation, but per his own
comment on the call, it shouldn't hold up getting Beverly live — this build is
deliberately scoped to guest suites only.
