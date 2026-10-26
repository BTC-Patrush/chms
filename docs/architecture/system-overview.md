# System architecture — proposed baseline

- Modular monolith: Next.js UI and thin route handlers, domain application services, Drizzle/PostgreSQL.
- Single church per installation; multiple campuses.
- Separate background worker from same codebase; PostgreSQL transactional outbox.
- Better Auth with invitation-only adult accounts, five protected role templates and MFA for Admin/Finance.
- Protected local storage, SMTP, HTTPS reverse proxy, Docker Compose, encrypted off-server backups.
- Database and application authorization both required; trusted RLS identity remains unproven.

**Status: architecture draft; no implementation evidence.**
