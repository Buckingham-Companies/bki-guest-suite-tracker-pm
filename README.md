# Guest Suite Tracker

Internal booking calendar for Buckingham's on-site guest suites. Replaces a manually
maintained spreadsheet that couldn't keep up with nightly rates changing almost daily
(football season, IU events) and gave no way to show suites were actually booked and
generating revenue.

Started as a Claude-chat prototype built by Marliss Davis (Beverly property manager);
this build adds real persistence, role-based permissions, a full change-history/audit
trail, and reporting so it can go to production behind Okta on Azure.

## Purpose & intended users

- **Purpose**: track guest-suite reservations and nightly pricing per property; internal
  only, not guest-facing (confirmed on the 2026-07-16 planning call).
- **Users**: on-site property management staff (property managers, APMs, leasing) create
  and view reservations; only property managers + Marliss set nightly rates.

## Owner

- **Department Lead / owner**: Marliss Davis (Beverly)
- **Innovation contact**: Rebecca Dodge
- **IT / deployment**: Shane Wells

## Data sources

- **Azure SQL Database**, owned by this app — not a read or write integration with
  Yardi or SharePoint. Stores properties, units, bookings (including guest name,
  email, phone, and birth month/year — collected only to confirm Katie's 25-and-older
  policy, not a full date of birth), nightly rates, and an audit log of every
  booking/rate change.
- Payment/accounting for a booked stay happens outside this app, through Buckingham's
  existing process (per the planning call) — this tool tracks the reservation, not
  the payment.

## Access

- Okta groups: `GuestSuites-Admin` (set nightly rates + everything staff can do),
  `GuestSuites-Staff` (create/view/edit/cancel reservations, view rates, cannot set
  pricing). See `infra/README.md` for exact provisioning steps.

## Data storage, versioning, and reporting

- **Storage**: Azure SQL Database — see `database/schema.sql`.
- **Change history**: every booking and rate insert/update/delete writes a row to
  `AuditLog` (who, when, before/after values) in the same transaction as the change
  itself. Bookings are soft-deleted (`IsDeleted`), so a cancelled reservation still
  shows up in history and in reports instead of disappearing. Surfaced in the app as
  the "History" section on a booking; queryable directly for anything deeper.
- **Reporting**: an in-app Reports tab (occupancy % and revenue by unit/month, upcoming
  check-ins/outs) plus two SQL views (`vw_OccupancyByUnitMonth`, `vw_RevenueByUnitMonth`
  in `database/views.sql`) that Power BI can connect to directly for anything beyond
  that.

## Architecture

- `frontend/` — static HTML/CSS/JS calendar UI, deployed as an Azure Static Web App.
- `api/` — Azure Functions (Node.js, no build step) — the only thing that talks to
  the database; enforces the admin/staff permission split server-side regardless of
  what the UI shows.
- `database/` — schema, reporting views, and seed data for Beverly.
- `infra/README.md` — what Shane needs to provision in Azure + Okta, in order.
- `local-dev/mock_server.py` — a stdlib-only Python stand-in for the real API, used
  to test the frontend without needing Azure/Node installed. **Not deployed.**

## Known limitations

- Built and tested against Beverly's 3 units only; adding another property (Foundry is
  next) is a data insert, not a code change — see `infra/README.md`.
- Revenue-by-month prorates a multi-night stay's price evenly across its nights; a stay
  priced at a flat rate that happens to span a month boundary will show as evenly split
  rather than however the front-desk staff actually priced each night.
- The broader "replace CityWay amenity booking" idea Shane raised is intentionally out
  of scope for this build (see `infra/README.md`).
- This build was assembled and code-reviewed in a Claude Code session without Node.js,
  Docker, or SQL tooling installed on the machine, so the *production* stack (real
  Azure Functions + Azure SQL + real Okta) has not been run end-to-end — see
  `local-dev/README.md` for what was actually verified, and the smoke-test checklist
  in `infra/README.md` for what to confirm right after deploying.

## Skill Registry

Not yet registered — add an entry once this is live, per the Innovation team's
standard process, and link it here.
