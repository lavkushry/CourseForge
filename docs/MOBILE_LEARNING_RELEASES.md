# Mobile learning releases

The three phases ship as separate commits. Each can be deployed without the
following phase. Course and lecture IDs, enrollment, saved notes, and playback
permissions remain in place. Instructor assessments are required: missing
questions are not generated from slides or invented to issue certificates.

## Phase 1: phone foundation

- Bottom Home, Today, Courses, and Review tabs at widths through 768px.
- A persistent Next lesson action, safe-area spacing, and keyboard-aware forms.
- A rightward swipe from the left edge returns to courses without capturing
  player controls or form fields. My courses and browser Back remain available.
- Player touch controls are at least 44px. Portrait controls avoid overlapping
  Play and the timeline. On small phones the upper toolbar keeps Lock; notes
  and study tools remain below the player. Fullscreen retains the watermark,
  uses landscape orientation where supported, and releases the lock on exit.
- Account bootstrap combines course metadata, progress, preferences, and recent
  lessons in one private request. Study tools and Media Chrome load separately.
  Text compression excludes video streams and range requests.

Build shipped assets after changing a static source:

```bash
python3 scripts/build_web_assets.py
.venv/bin/python -m pytest -q
.venv/bin/python scripts/mobile_walkthrough.py
```

The walkthrough uses a temporary SQLite copy of the actual 210-lecture library
and a temporary learner. Its records never enter production. It checks
dashboard, planning, library, player, notes, and assessments at 320/390/768,
real Odysee playback, fullscreen watermark visibility, and landscape layout.
Artifacts remain in ignored `data/phase1-*` files.

Performance measurement is a cold-cache lesson shell on Chromium, Fast 3G
(1.6 Mbps download, 750 Kbps upload, 150ms latency), with 4x CPU throttling.
Interactive means the lesson title and Next lesson action are usable. It does
not mean the first video frame has arrived: Odysee preparation and buffering
are measured separately. Three fresh browser contexts prevent an older video
download from competing with the next page-load measurement.

Validation on 2026-10-10: 148 tests passed; cold interactive times were
1301.9ms, 1314.5ms, and 1296.0ms. Real playback, fullscreen rotation, and
watermark visibility passed with no browser script errors.

Deploy by backing up SQLite, updating the checked revision, and restarting
`courseforge.service` and `courseforge-academy-worker.service`. Leave the tunnel
running. Asset version 14 invalidates previous page bundles.

## Phase 2: daily learning

Pending the next independently validated release.

## Phase 3: quizzes, review, and certificates

Pending instructor assessments and the next independently validated release.
