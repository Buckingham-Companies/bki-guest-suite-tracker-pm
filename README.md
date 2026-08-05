# Guest Suite Tracker

Booking calendar and rate tracker for Buckingham property guest suites.

- [`frontend/`](frontend/) — static site (Azure Static Web Apps content), Okta-authenticated
- [`api/`](api/) — Azure Functions v4 backend (Node), linked to the Static Web App
- [`database/`](database/) — Azure SQL schema, views, and seed data (run in that order)
- [`infra/README.md`](infra/README.md) — Okta and Azure provisioning steps
