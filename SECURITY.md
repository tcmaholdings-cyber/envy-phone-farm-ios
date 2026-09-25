# Security Policy

Do not report vulnerabilities through public issues. Until a dedicated address is configured, contact the repository owners privately through the GitHub organization.

Never attach a self-hosted production runner to this repository's workflows. Never include device passcodes, Apple signing material, real UDIDs, authentication tokens, screenshots, uploaded media, or production logs in an issue or pull request.

## Tenant isolation

The farm hosts several customer organisations (tenants) on shared hardware
([docs/tenants.md](docs/tenants.md)). Treat any way for one tenant's user to
see, change or even confirm the existence of another tenant's phones,
schedules, runs, uploads, people, groups, grants or audit rows as a
vulnerability and report it privately, as above. The rules are in
`src/auth/policy.ts`; every route's requirement is in
`src/auth/route-access.ts`; `test/tenant-isolation.test.ts` must keep passing.

- Another tenant's resource answers 404, never 403; platform-only routes
  answer a uniform 403.
- `PHONE_FARM_AGENT_TOKEN` (multi-host) and `PHONE_FARM_METRICS_TOKEN` are
  farm-operator secrets: the agent token reaches every phone on a host. Never
  give either to a tenant.
- Uploaded media belongs to a tenant; files are stored under random names,
  capped per file (`PHONE_FARM_MAX_UPLOAD_BYTES`) and per tenant.

## Audit log

Every state-changing request and every account event is recorded in
`auth.audit_log`, which the database keeps append-only (no UPDATE, no
TRUNCATE, no DELETE of rows younger than 30 days). It never contains request
bodies, passwords, tokens, passcodes or typed text — a change that would put
one there is a vulnerability. Include audit rows in a report only after
removing IP addresses and ids that identify a customer.
