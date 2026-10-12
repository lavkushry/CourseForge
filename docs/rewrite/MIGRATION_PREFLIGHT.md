# Read-only SQLite migration preflight

`python3 scripts/rewrite_migration_preflight.py` checks an explicitly supplied,
isolated, standalone SQLite snapshot against the source inventory. It reports
aggregate diagnostics; it does not import data, open production SQLite, contact
Odysee, write PostgreSQL, export a raw archive, or establish feature parity.

```sh
python3 scripts/rewrite_migration_preflight.py \
  --snapshot /private/isolated/courseforge-snapshot.sqlite3 \
  --isolated-snapshot
```

There is no default database path. `--isolated-snapshot` asserts that the operator
has supplied a consistent isolated backup after draining source writers. This
assertion is not independently proved by the CLI. It rejects the repository's
`data/` directory, the configured `DATA_DIR`, symlink files, hard-link aliases of
the conventional live database and snapshots with WAL/SHM/journal sidecars. It
opens the explicit file with `mode=ro&immutable=1`, sets `query_only`, disables
trusted schema execution and never imports an application module. Immutable mode
avoids lock/WAL/SHM creation; the sidecar rejection prevents ignoring outstanding
WAL writes. The operator must create a consistent standalone backup; copying an
active main SQLite file without its WAL is insufficient.

Validation uses a 30-second work budget, configurable with
`--timeout-seconds` in `(0,600]`. SQLite instruction checks and row traversal stop
on budget exhaustion and produce a failing aggregate diagnostic. File identity,
size and modification time are compared before/after validation. These checks
catch ordinary concurrent changes; they do not establish trusted snapshot
provenance against an adversary modifying a file while preserving metadata.

## Output contract

JSON goes to stdout. For unchanged source inventory and snapshot, complete runs
produce deterministic JSON: fixed version, sorted known-table row counts and
sorted diagnostic code/table/count entries. It emits no input path, row ID, email,
name, IP, device, credential/hash/token, question, answer, feedback, source text or
SQLite error text. Unknown table/column identifiers are counted, never echoed.
Arguments rejected by argparse concern CLI syntax only; source/data failures use
fixed diagnostic codes.

| Field | Meaning |
| --- | --- |
| `inventory_source_current` | Every recorded source hash matched the current checkout; hash values are never reported. Staleness is a hard migration blocker. |
| `snapshot_checks_passed` | Complete source-schema/integrity/data checks found no reported snapshot hazard. It does not approve destination transforms. |
| `migration_authorized` | Always `false` at this foundation stage; no semantic importer or recovery gate is executed by this command. |
| `postgresql_writes` | Always zero; there is no PostgreSQL client or write path. |
| `row_counts` | Counts for inventory-known tables that are present; no per-learner grouping or record contents. |
| `diagnostics` | Aggregate codes with optional inventory-known table and count. Counts can represent rows, fields, constraints or intervals, according to the code. |
| `verdict` | `blocked`; a source-check pass is not a cutover approval. |

Exit code is **1** whenever migration is not authorized, including a structurally
valid empty snapshot. Exit code **2** is argparse usage failure. This deliberate
fail-closed contract prevents a clean source check from being interpreted as a
successful feature migration. There is no bypass flag that approves unsupported
mappings. A future typed importer must provide independent mapped-field,
artifact/vector, restart/recovery and feature-parity proof before any authorization
contract changes.

The checked-in inventory includes effective columns/constraints for 67 legacy
tables. Unknown tables, columns, views and triggers are rejected by default.
Recognized SQLite sequence and FTS5 shadow tables are explicit internal exceptions.
Missing known tables also fail; a snapshot from an earlier schema must first have
an explicit versioned upgrade/reconciliation plan rather than silently losing
uninitialized feature data. Source ordinal/type/nullability/primary key,
foreign-key, CHECK and unique/partial-index differences fail schema checks.

## Checked source hazards

| Area | Checks |
| --- | --- |
| Integrity/schema | Read-only SQLite integrity/FK checks; expected table/column definitions, constrained keys, CHECKs and partial unique predicates; unknown objects; source inventory staleness. |
| Ownership/references | Missing/null/`legacy` owners, nullable AI-log ownership, anonymous streaming exceptions, missing audit actors, dangling lessons/material lessons, course/lesson mismatches, cross-owner review/path/assessment/practice/focus parents and quiz-attempt lesson mismatch. |
| JSON/citations | Invalid/oversized JSON, duplicate keys, non-finite constants, wrong top-level array/object shape, missing nested lesson/chunk citations and mismatched nested course/lesson/chunk references. Traversal is bounded. |
| Time/accounting | Invalid/non-finite/negative numeric times/counts, malformed or timezone-ambiguous timestamps, invalid local dates, non-Monday weeks, out-of-range timezone offsets and invalid boolean/player-speed values. Epoch lease expiry is checked as a number, separately from ISO timestamps. |
| Coverage | Invalid/reversed/out-of-order/overlapping native intervals, intervals beyond stored duration and native/source duration discrepancy. Played time remains separate from interval coverage; no reconciliation or additional credit is fabricated. |
| Quizzes | Multiple legacy quizzes per lesson, unsupported question count, malformed/duplicate question IDs, invalid answer indexes/options/source times and score/count discrepancies. Historical missing result/version fields remain migration blockers. |
| Materials | Invalid scope, lesson scope without lesson, unsafe filename and missing/mismatched lesson/course reference. No material file or provider manifest is opened. |
| Freeze/work | Running legacy jobs, running focus sessions and open focus intervals require recorded writer drain/freeze reconciliation. No work is cancelled or resumed by preflight. |

These checks identify hazards; they do not fully validate every domain payload,
prove Argon2 compatibility, verify source content or replace public API/browser
parity evidence. Bounds or schema differences are reported for explicit resolution;
values are never truncated, remapped or discarded. No owner=`legacy` is assigned
to an arbitrary administrator.

## Remaining migration blockers

The complete per-table mapping requirements are in
[MIGRATION_INVENTORY.md](MIGRATION_INVENTORY.md) and its machine-readable JSON.
A populated feature table always has `mapping_semantics_unverified` until a typed
transform and semantic comparison exist. Missing destination schemas or preserved
source fields add their own hard blockers. In particular:

- Source video path/bytes/mtime/language/indexed/error provenance and screen-frame
  paths require preserved destinations and a validated relocation manifest.
- Native playing totals, coverage, saved position/duration, visible-page activity,
  focus time and planned/actual minutes require independent transformations.
  Already cumulative totals must not have retained session time added again.
- Historical native/activity/auth/player reports and their relationships require
  retained private reporting while active cookies, links and leases are
  invalidated. Invalidation does not authorize deleting report history.
- Exact analytics events/user/meta/timestamps cannot disappear into daily name
  aggregates without an explicit retention decision and retained feature behavior.
- Review attempts lack historical schedule/revision data. Legacy quiz attempts lack
  stored result/version fields; multiple quizzes per lesson conflict with the new
  unique constraint. These values cannot be invented from current content.
- Certificates and verification codes, generated syllabi/path fingerprints,
  topic/practice/interview/placement results, habits, reminders, planning and lab
  records need actual destination schemas and private feature behavior.
- Legacy global indexing jobs and course/global task kinds differ from Go jobs
  requiring an owner, lesson and restricted kind. Worker drain, checkpoints,
  idempotency and fenced publication need explicit per-kind transforms.
- Artifact checksums/root mappings, transcript-cache provenance, frame/cover/material
  access, private lab workspace files and versioned Qdrant/model/dimension/point
  manifests must be verified after writers stop. SQL checks alone cannot prove a
  complete restore or preserved retrieval citations.
- Password hash compatibility, constraint edge cases, stable IDs/timestamps,
  sequence reseeding, every mapped field/count/aggregate, session invalidation,
  crash/retry import, measured freeze duration, complete backup restore and
  post-write recovery remain release gates.

A raw-row recovery archive is an adjunct, never a feature migration. This CLI
creates no archive and has no warning-only success for missing semantic transforms.

## Synthetic verification

```sh
python3 -m unittest discover -s tests -p rewrite_migration_preflight_test.py -v
```

The 22 synthetic tests passed on 2026-10-12. They construct all 67 source schemas in
private temporary snapshots, never load app modules or production data, and check
read-only/deterministic output, schema drift, unknown objects, ownership, references,
private-output canaries, malformed JSON/time, coverage, quiz/material discrepancies,
active work, epoch leases, live-directory/hard-link/symlink/sidecar rejection and
budget exhaustion. No real migration, live snapshot, artifact/vector restore or
capacity result is claimed.
