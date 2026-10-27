# ADR-008 — Case-insensitive name comparison and text normalization
Status: Accepted, with amendments
Date: 2026-10-27
Context: BR-07 (approved) requires campus names to be unique within a church under case-insensitive comparison, with archived names staying reserved. BR-08 (approved) requires a display name for each person, with structured components optional. On 2026-10-27 the product owner approved the name rules recorded as PPD-01 in the [decision register](../../decisions/CHMS-F001-decision-register.md#3-approved-name-rules-closes-rr-16-for-f001), which close RR-16 for CHMS-F001.

Relevant PostgreSQL 18 facts (documentation checked 2026-10-27):
- `casefold()` "facilitate[s] case-insensitive matching", depends on the collation, and requires UTF8 server encoding ([string functions](https://www.postgresql.org/docs/18/functions-string.html)).
- `IS [NOT] [form] NORMALIZED` defaults to NFC and requires UTF8 (same page).
- `btrim(string)` removes only **spaces** by default (same page). It does not remove tabs, newlines or other Unicode whitespace.
- The builtin locale provider supports `C`, `C.UTF-8` and `PG_UNICODE_FAST`. `PG_UNICODE_FAST` is new in PostgreSQL 18; it "supports case mapping, but sorts in code point order" ([locale support](https://www.postgresql.org/docs/18/locale.html), [release notes](https://www.postgresql.org/docs/18/release-18.html)).

Decision:
1. Database encoding `UTF8` with the builtin locale provider (`PG_UNICODE_FAST` or `C.UTF-8`, chosen by proof CP-08), so index validity does not depend on operating-system collation libraries.
2. The rules apply to every F001 name: the church `name`, campus `name`, person `display_name`, and `given_name` and `family_name` when present. Components are NULL when absent, never empty strings (BR-08). Names are stored as entered after normalization and trimming, so display capitalization is preserved. Comparison never changes stored text.
3. Order at the service boundary: reject input that is not well-formed Unicode, normalize to NFC, trim leading and trailing whitespace, then validate. "Whitespace" means the Unicode `White_Space` property. Internal whitespace is kept as entered and never collapsed. Length means Unicode code points (`char_length`) after NFC and trimming, and must be 1–100. The exact character classes and their behaviour under the chosen locale are unverified (proof CP-08).
4. The database rejects names that break these rules:
   - `IS NFC NORMALIZED`;
   - a pattern check that rejects leading or trailing whitespace (`btrim()` alone is insufficient, because it removes only spaces);
   - a pattern check that rejects control characters (Unicode general category `Cc`: U+0001–U+001F and U+007F–U+009F; PostgreSQL `text` cannot contain U+0000);
   - `char_length(name) BETWEEN 1 AND 100`.

   Invalid UTF-8 byte sequences are rejected by the `UTF8` database encoding. JavaScript strings that are not well-formed (lone surrogates) are rejected by the boundary schema before they are encoded.
5. Case-insensitive uniqueness applies only where already required: campus names within a church, including archived rows (BR-07). The unique index is `campuses_name_ci_uq ON (church_id, casefold(name))` if CP-08 proves `casefold()` `IMMUTABLE` and suitable for that index; otherwise it is `ON (church_id, lower(name))`. The choice is delegated to compatibility testing, recorded in the implementation PR, and needs no further product-owner approval. No other name is unique.

Amendments on acceptance (2026-10-27): the proposal covered campus names only, with 1–120 characters, and left church-name and person-name limits open. The product owner amended it to 1–100 characters for all F001 names, added rejection of control characters and invalid Unicode, ruled out collapsing internal whitespace, and approved `lower()` as the fallback when `casefold()` is unsuitable.

Alternatives:
- `lower()` alone: simpler, but does not perform full case folding (for example `ß` against `SS`), and its behaviour depends on the collation. Kept as the approved fallback (Decision 5).
- An ICU nondeterministic collation with a plain unique constraint: correct comparisons, but it changes ordering and pattern-matching behaviour and depends on ICU versions.
- The `citext` extension: an extra extension dependency, based on `lower()`.
- `CHECK (name = btrim(name))`: rejected, because it only detects leading and trailing spaces.
Consequences:
- UTF8 is mandatory.
- Using `casefold()` in the unique index requires it to be `IMMUTABLE`; this is unverified (CP-08). With the `lower()` fallback, `ß` and `SS` are not treated as equal.
- Results for `ß`/`SS`, dotted and dotless `I`, and final sigma depend on the function and the locale, and are unverified (TS-F001-07).
- Names longer than 100 characters are rejected, never truncated.
- Homoglyphs (look-alike characters from different scripts) are not detected.
- Changing the locale provider after data exists requires a rebuild.
Security impact: low. It prevents duplicate campuses that differ only in case, Unicode composition or surrounding whitespace, and keeps control characters out of stored names.
Verification (not executed): TS-F001-06, TS-F001-07, TS-F001-14 and TS-F001-15 in the [test matrix](../../features/CHMS-F001/test-matrix.md). Execution status: NOT RUN.
Approvers: Patrush (product owner), 2026-10-27, with the amendments above.
