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
six mock users to check both the admin/staff split *and* the multi-property
`user.YardiNumber` access model (see `CLAUDE.md` "Multi-Property Access Model"):

| Profile           | Title              | YardiNumber(s) | Sees                        |
|--------------------|--------------------|-----------------|------------------------------|
| `admin-beverly`     | Property Manager   | 1271            | Beverly, as Admin            |
| `staff-beverly`     | Leasing Consultant | 1271            | Beverly, as Staff            |
| `admin-portrait`    | Property Manager   | 1264            | Portrait Midtown, as Admin   |
| `staff-portrait`    | Leasing Consultant | 1264            | Portrait Midtown, as Staff   |
| `regional-admin`    | Regional Manager   | 1271, 1264      | Both properties, as Admin    |
| `no-property`       | Leasing Consultant | (none)          | Nothing — empty property list, the "Okta claim not wired up yet" case |

The database seeds both properties automatically (`The Beverly` / Yardi #1271,
`Portrait Midtown` / Yardi #1264, Unit 301, with its Sept–Dec 2026 rates) so
`admin-portrait`/`staff-portrait`/`regional-admin` have real data to look at
without any manual setup.

## What this does and doesn't prove

Confirms the frontend/API contract is internally consistent — the calendar renders,
bookings save with the right computed price, the admin/staff split behaves as designed,
audit history shows up, the report numbers move correctly, and — as of the
multi-property rework — that property visibility and write access are correctly scoped
by `YardiNumber` (a `staff-beverly` user genuinely cannot see or touch Portrait
Midtown, and vice versa). It does **not** exercise real Azure Functions, real Azure SQL
(T-SQL syntax like `MERGE` and `OUTPUT INSERTED.*` in `api/src/functions/*.js` isn't run
by this mock — it's re-implemented in plain SQLite), or real Okta/SWA auth wiring —
in particular, it can't tell you whether Okta will actually send `YardiNumber` as a
multi-value claim or a delimited string once IT wires it up (see CLAUDE.md). Shane's
post-deploy smoke test in `infra/README.md` is the real end-to-end check.
