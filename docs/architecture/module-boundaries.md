# Module boundaries

Domains D-01 through D-16 remain distinct application responsibilities. DB-01 through DB-08 are schema design packages, not separate databases. Shared database, domain-owned tables and application services; no arbitrary cross-module table writes. Shared audit/outbox infrastructure must have explicit ownership.
