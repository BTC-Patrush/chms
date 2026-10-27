# ADR-008 — Case-insensitive name comparison and text normalization
Status: Proposed
Date: 2026-10-27
Context: BR-07 (approved) requires campus names to be unique within a church under case-insensitive comparison, with archived names staying reserved. BR-08 (approved) requires a display name for each person, with structured components optional. PPD-01 (RR-16) is a **proposed product-owner decision awaiting confirmation** for campus names: unique within a church including archived records; leading and trailing whitespace trimmed; case-insensitive comparison; NFC normalization; 1–120 characters after trimming; display capitalization preserved. PPD-01 does not cover church names or person names.

Relevant PostgreSQL 18 facts (documentation checked 2026-10-27):
- `casefold()` "facilitate[s] case-insensitive matching", depends on the collation, and requires UTF8 server encoding ([string functions](https://www.postgresql.org/docs/18/functions-string.html)).
- `IS [NOT] [form] NORMALIZED` defaults to NFC and requires UTF8 (same page).
- `btrim(string)` removes only **spaces** by default (same page). It does not remove tabs, newlines or other Unicode whitespace.
- The builtin locale provider supports `C`, `C.UTF-8` and `PG_UNICODE_FAST`. `PG_UNICODE_FAST` is new in PostgreSQL 18; it "supports case mapping, but sorts in code point order" ([locale support](https://www.postgresql.org/docs/18/locale.html), [release notes](https://www.postgresql.org/docs/18/release-18.html)).

Decision (proposed):
1. Database encoding `UTF8` with the builtin locale provider (`PG_UNICODE_FAST` or `C.UTF-8`, chosen by proof CP-08), so index validity does not depend on operating-system collation libraries.
2. Campus names are stored as entered after normalization, so display capitalization is preserved (PPD-01). Comparison never changes stored text.
3. Normalization order at the service boundary: NFC first, then trim leading and trailing whitespace, then check length. "Whitespace" means the Unicode `White_Space` property. The exact character class and its behaviour under the chosen locale are unverified (proof CP-08). Length means Unicode code points (`char_length`) after NFC and trimming. Both readings need confirmation with PPD-01.
4. The database rejects names that break these rules: `CHECK (name IS NFC NORMALIZED)`; a trim check that rejects leading or trailing whitespace by pattern (`btrim()` alone is insufficient, because it removes only spaces); and `CHECK (char_length(name) BETWEEN 1 AND 120)` for campus names.
5. Campus-name uniqueness uses the unique index `campuses_name_ci_uq ON (church_id, casefold(name))`. It covers archived rows (BR-07, PPD-01).
6. Church names, person `display_name`, `given_name` and `family_name`: the same normalization and trimming are proposed, but their **length limits are open**, because PPD-01 does not cover them (RR-16). Components are NULL when absent, never empty strings (BR-08).
Alternatives:
- `lower()`: simpler, but does not perform full case folding (for example `ß` against `SS`). Its behaviour depends on the collation.
- An ICU nondeterministic collation with a plain unique constraint: correct comparisons, but it changes ordering and pattern-matching behaviour and depends on ICU versions.
- The `citext` extension: an extra extension dependency, based on `lower()`.
- `CHECK (name = btrim(name))`: rejected, because it only detects leading and trailing spaces.
Consequences:
- UTF8 is mandatory.
- `casefold()` must be usable in an index expression, which requires it to be `IMMUTABLE`; this is unverified (CP-08).
- Results for `ß`/`SS`, dotted and dotless `I`, and final sigma depend on the locale and are unverified (TS-F001-07).
- Homoglyphs (look-alike characters from different scripts) are not detected.
- Changing the locale provider after data exists requires a rebuild.
Security impact: low. It prevents duplicate campuses that differ only in case, Unicode composition or surrounding whitespace.
Verification (not executed): TS-F001-06, TS-F001-07, TS-F001-14 and TS-F001-15 in the [test matrix](../../features/CHMS-F001/test-matrix.md). Execution status: NOT RUN.
Approvers: none yet. Requires product-owner confirmation of PPD-01 and approval of this exact content.
