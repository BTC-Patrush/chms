# ADR-007 — CHMS-F001 platform baseline: PostgreSQL 18, container image, Node.js and Drizzle
Status: Proposed
Date: 2026-10-27
Context: BR-10 (approved) makes PostgreSQL 18 the target major version, subject to compatibility verification. `CLAUDE.md` lists the planned stack (Next.js, TypeScript, PostgreSQL, Drizzle ORM) without versions (audit R-07, RR-13). F001 needs a database, a driver, migration tooling and a disposable test database. Nothing has been installed.
Decision:
1. **PostgreSQL 18**, using the latest minor release at implementation time. Database encoding `UTF8`; locale provider per ADR-008.
2. **Container image for local and CI test databases:** the official `postgres:18-trixie` image, pinned by digest when implementation starts. Data is mounted at `/var/lib/postgresql`, because the PostgreSQL 18 image sets `PGDATA=/var/lib/postgresql/18/docker` and declares `VOLUME /var/lib/postgresql`. The PostgreSQL 17 image instead uses `PGDATA` and `VOLUME /var/lib/postgresql/data` (both official Dockerfiles checked 2026-10-27). Production deployment is out of scope.
3. **Node.js 24 LTS** with TypeScript in strict mode.
4. **ORM and driver:** `drizzle-orm` 0.45.x, `drizzle-kit` 0.31.x (at least 0.31.7) and `pg` (node-postgres) 8.x. Exact versions are pinned when implementation starts.
5. **Migration workflow:**
   - `drizzle-kit generate` produces tables, constraints and indexes.
   - `drizzle-kit generate --custom` produces hand-reviewed SQL for roles, grants, functions and triggers.
   - Migrations are applied explicitly by an operator, never on application startup.
   - `drizzle-kit push` is not used.
6. The test runner and boundary-schema library are chosen at the toolchain step; they are not decided here.
Compatibility evidence (checked 2026-10-27; nothing executed locally):

| Item | Evidence | Source |
|---|---|---|
| PostgreSQL 18 supported | 18.6 is current; supported until 2030-11-14; 18.0 released 2025-09-25 | [Versioning policy](https://www.postgresql.org/support/versioning/), [release notes](https://www.postgresql.org/docs/18/release-18.html) |
| UUIDv4 generation | `gen_random_uuid()`; `uuidv4()` is a synonym; `uuidv7()` also exists | [UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html) |
| `xid8`, `pg_current_xact_id()` | `pg_current_xact_id () → xid8`; `xid8` increases strictly monotonically | [System information functions](https://www.postgresql.org/docs/18/functions-info.html), [OID types](https://www.postgresql.org/docs/18/datatype-oid.html) |
| `casefold()` | Available; requires UTF8 server encoding | [String functions](https://www.postgresql.org/docs/18/functions-string.html) |
| Catalog change | NOT NULL constraints are now stored in `pg_constraint`, which can affect schema introspection | [Release notes](https://www.postgresql.org/docs/18/release-18.html) |
| Docker image | `postgres:18`, `18.6` and `18-trixie` updated 2026-10-21; `18-alpine` updated 2026-10-26; Dockerfile `PG_VERSION 18.6-1.pgdg13+2` | [Docker Hub](https://hub.docker.com/_/postgres), [Dockerfile](https://github.com/docker-library/postgres/blob/master/18/trixie/Dockerfile) |
| drizzle-orm | 0.45.4 (published 2026-10-08); peer dependency `pg >=8` | [npm](https://www.npmjs.com/package/drizzle-orm) |
| drizzle-kit | 0.31.11 (published 2026-09-21); PG18 push/introspection bug fixed in 0.31.7 | [npm](https://www.npmjs.com/package/drizzle-kit), [#4944](https://github.com/drizzle-team/drizzle-orm/issues/4944) |
| pg (node-postgres) | 8.23.1 (published 2026-09-30); requires Node ≥ 16 | [npm](https://www.npmjs.com/package/pg) |
| Node.js | 24.22.1 is the current LTS ("Krypton"); 26.x is not yet LTS | [Node.js releases](https://nodejs.org/dist/index.json) |
| Drizzle schema features | `check()`, composite `foreignKey({ columns, foreignColumns })`, expression and partial (`.where()`) indexes, custom SQL migrations | [Indexes & constraints](https://orm.drizzle.team/docs/indexes-constraints), [custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations) |

Known gaps and risks:
- **Unverified implementation risk:** [drizzle-orm #6572](https://github.com/drizzle-team/drizzle-orm/issues/6572) (open, no maintainer response, as of 2026-10-27). The reporter says that, on our proposed versions (drizzle-orm 0.45.4, `pg` 8.23.1, PostgreSQL 18.6), catching a statement error **inside** the `db.transaction()` callback leads PostgreSQL to answer `COMMIT` with `ROLLBACK`, yet the call resolves as successful. We have not reproduced it. ADR-004's pattern never catches inside the callback, so it is affected only if that rule is broken. Proof CP-05 must reproduce or rule out the report; TS-F001-33 guards against regressions.
- [drizzle-orm #5879](https://github.com/drizzle-team/drizzle-orm/issues/5879) (open; only its title was reviewed): `push` keeps re-adding a `UNIQUE NULLS NOT DISTINCT` constraint. Avoided by not using `push`.
- Not verified in this session:
  - the documented syntax for foreign-key `onUpdate` / `onDelete` actions;
  - whether Drizzle tests against PostgreSQL 18 in its own CI;
  - `drizzle-kit check` and drift detection on PostgreSQL 18;
  - ORM representation of `CHECK`/`IS NFC NORMALIZED`, the `casefold()` index, and `MATCH SIMPLE` composite foreign keys.

  These are compatibility proofs CP-01 to CP-09 in the [readiness report](../../features/CHMS-F001/implementation-readiness.md).
- Roles, grants, functions and triggers are outside Drizzle's model, so drift detection must also query the catalog for those objects (TS-F001-35).
Alternatives:
- PostgreSQL 17: supported, but `casefold()`, `uuidv7()` and the `PG_UNICODE_FAST` locale are all listed as new in the [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html).
- The `postgres` (postgres.js) driver, 3.4.9.
- Drizzle 1.0 release candidates (not stable).
- An ORM outside the planned stack.
Consequences:
- A large share of F001 lives in reviewed custom SQL.
- Upgrading ORM versions needs regression runs of the concurrency and privilege tests.
- Pinning the image by digest requires a later Dependabot decision for the Docker ecosystem.
Security impact: pinned images and dependencies reduce supply-chain drift, and the explicit migration step prevents schema changes on application startup.
Approvers: none yet. BR-10 is approved; this ADR's exact contents are not.
