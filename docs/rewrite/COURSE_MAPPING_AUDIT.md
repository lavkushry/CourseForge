# Course mapping and catalog reconciliation

Read-only evidence captured 2026-10-13T02:01:22.371900+00:00. The deployed PostgreSQL database already contains real imports; it is treated as production. This audit made no production writes, created no accounts, called no provider endpoints and restarted no services.

All **3,870 legacy lesson stable IDs are present** in Go. The primary mapping defect is missing provider associations, not lost course IDs. PostgreSQL has 30 courses and 3,875 lessons; the three additional courses and five lessons are former synthetic fixtures and require explicit production cleanup review.

**Current exact repair: 27 provider inserts.** PostgreSQL has 983 associations; SQLite has 1,010 valid associations belonging to current lessons, plus two orphan provider rows. Existing overlapping claims agree. The manifests contain the same 1,010 entries and do not provide mappings for the remaining 2,860 original lessons. An exact repair would leave 2,865 PostgreSQL lessons without mappings, including five synthetic extras. Never generate a claim or use a similar title to fill this gap.

The source was changing during inspection: the first snapshot had 1,009 valid mappings and 26 omissions, then SQLite and both manifests increased by one. Snapshot fingerprints must be revalidated before any repair. Independent read transactions do not constitute a migration write freeze.

## Catalog losses

- Every one of the 3,870 imported lesson sections is blank, although the legacy pure section inference supplies a section for each.
- 145 flow-order numeric values differ. The current ordered stable-ID sequence agrees for all 27 courses; repair flow values without inventing a different sort order.
- 25 course descriptions differ. Publication flags agree for existing source publication rows.
- The 138 document-manifest entries have valid provider identifiers and known courses, but PostgreSQL has zero materials. Legacy SQL material metadata is empty because these materials were discovered from the manifest at request time.
- All 3,870 legacy local video paths are absent on this host. They cannot be used as local-media fallbacks.
- Legacy declares 25 covers; Go declares 27 cover paths. These counts do not prove correct images or accessible assets.

## Deterministic repair protocol

`scripts/rewrite_course_mapping_audit.py` has no apply mode. Its planning function accepts a persisted immutable lesson ID, or an exact course-qualified filename with a unique existing lesson. Explicit IDs, path identity and course identity must agree. Unqualified filenames, case/fuzzy matches, unknown IDs, duplicate filenames, conflicting claims and changed destination courses are rejected. Existing provider associations are never overwritten. Proposed duplicate claims are rejected.

A coordinator-requested private payload was prepared under `/tmp/courseforge-exact-mapping-repair.sql` and `.json`, both mode 0600. These private files contain provider identifiers and must not be published. Their transaction locks lesson identity and provider state, verifies the full current provider fingerprint, verifies every exact lesson/course pair is present and unmapped, rejects existing claim reuse, then inserts and verifies the full set atomically. The coordinator must take a backup and revalidate the source/manifests against the private JSON fingerprints immediately before applying it. This agent did not apply it.

A separate mode-0600 `/tmp/courseforge-exact-catalog-repair.json` contains exact section/flow proposals with old destination values and original publication descriptions. These values are obtained by extracting the pure `compute_flow_order` function from `app/main.py` and `infer_section_title` from `app/course_metadata.py` without importing or executing the application. There is no `app/course_structure.py` in the current tree. Catalog/material migration needs its own reviewed transaction and artifact/delivery checks.

## Per-course coverage

| Course | Lessons | Source mappings | Go mappings | Exact insert candidates | Still unmapped after repair |
| --- | ---: | ---: | ---: | ---: | ---: |
| Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026 | 62 | 62 | 62 | 0 | 0 |
| Arpit Bhaiyani - System Design Course | 52 | 0 | 0 | 0 | 52 |
| Azure Data Bricks by Sameer Sir Durgasoft | 40 | 0 | 0 | 0 | 40 |
| Codebasics Data Engineering Bootcamp 1.0 | 303 | 0 | 0 | 0 | 303 |
| Deepak Data Engg | 148 | 148 | 148 | 0 | 0 |
| Gaurav Sen AI Engineering 2026 | 30 | 29 | 29 | 0 | 1 |
| Gaurav Sen Low Level Design (LLD) 2026 | 81 | 81 | 60 | 21 | 0 |
| Gaurav Sen System Design Simplified (HLD) | 161 | 6 | 0 | 6 | 155 |
| Harkirat 100x combined bootcamp Coursedost | 313 | 0 | 0 | 0 | 313 |
| Keerti Purswani Agentic AI System Design Course 2026 | 17 | 0 | 0 | 0 | 17 |
| Namaste AI | 24 | 0 | 0 | 0 | 24 |
| Namaste SQL Coursedost | 18 | 0 | 0 | 0 | 18 |
| Sanket Advanced System Design HLD LLD 2026 | 506 | 0 | 0 | 0 | 506 |
| Sanket Singh Complete AI Engineer Bootcamp 2026 | 110 | 0 | 0 | 0 | 110 |
| Sanket Singh System Design 2.0 2026 | 507 | 0 | 0 | 0 | 507 |
| Sanket Singh Top Coding Interview Problem | 454 | 0 | 0 | 0 | 454 |
| Sanket Spring boot | 255 | 0 | 0 | 0 | 255 |
| Scaler DSA and System Design | 170 | 170 | 170 | 0 | 0 |
| Scaler Data Science | 110 | 110 | 110 | 0 | 0 |
| TrendyTech Ultimate Big Data Masters Program | 404 | 404 | 404 | 0 | 0 |
| Vimal Daga Courses 2025 | 27 | 0 | 0 | 0 | 27 |
| Vizuara AI - Build Voice Agents From Scratch 2026 | 9 | 0 | 0 | 0 | 9 |
| Vizuara AI - Context Engineering for LLMs 2026 | 11 | 0 | 0 | 0 | 11 |
| Vizuara AI - Master LLM Inference Engineering 2026 | 5 | 0 | 0 | 0 | 5 |
| Vizuara AI - Production AI Agents Bootcamp 2026 | 10 | 0 | 0 | 0 | 10 |
| Vizuara AI - Reinforcement Learning & RLHF 2026 | 8 | 0 | 0 | 0 | 8 |
| Vizuara AI - SLM Small Language Models Engineering 2026 | 35 | 0 | 0 | 0 | 35 |

## Verification and limits

`python3 scripts/rewrite_course_mapping_audit.py --self-test`: **13 synthetic tests pass**. They cover exact course scoping, unqualified/fuzzy rejection, explicit-ID/path conflicts, unknown ID rejection, invalid claims, source/current conflicts, idempotence, duplicate claims, ambiguous paths, changed destination course and aggregate report redaction. `python3 scripts/rewrite_course_mapping_audit.py` performed a read-only SQLite/PG audit and wrote aggregate metadata to `COURSE_MAPPING_AUDIT.json`.

Mapping presence does not prove provider authorization, byte delivery or decoded playback. The report does not audit learner records, claim historical feature parity, validate the local-media fallback, or establish capacity. No account names, tokens, provider claims, raw provider URLs or source paths are emitted in the aggregate report.
