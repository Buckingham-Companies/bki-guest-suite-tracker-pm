# Local dev mock — not part of the deployed app

`mock_server.py` is a stdlib-only Python stand-in for the real Azure Static Web App +
Azure Functions + Azure SQL stack. It exists so the frontend can be clicked through and
verified on a machine with no Node.js, Docker, or SQL Server installed — it implements
the same `/api/*` request/response contract as `api/src/functions/*.js`, backed by a
local SQLite file (`dev.db`, gitignored) instead of Azure SQL, and fakes `/.auth/me` the
way Azure Static Web Apps would after a real Okta login.

It is **not** deployed anywhere and is not part of what Shane ships to Azure.

## Run it

```
python local-dev/mock_server.py
```

Then open http://localhost:8787. A small "LOCAL MOCK" widget in the bottom-right corner
(injected only by this mock server, never present in the real app) lets you flip between
an admin session and a staff session to check the permission split.

## What this does and doesn't prove

Confirms the frontend/API contract is internally consistent — the calendar renders,
bookings save with the right computed price, the admin/staff split behaves as designed,
audit history shows up, and the report numbers move correctly. It does **not** exercise
real Azure Functions, real Azure SQL (T-SQL syntax like `MERGE` and `OUTPUT INSERTED.*`
in `api/src/functions/*.js` isn't run by this mock — it's re-implemented in plain SQLite),
or real Okta/SWA auth wiring. Shane's post-deploy smoke test in `infra/README.md` is the
real end-to-end check.
