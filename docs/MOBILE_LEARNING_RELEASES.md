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

Validation on 2026-10-10: 148 tests passed; cold interactive times after the
signup-to-completion walkthrough were 1330.0ms, 1361.1ms, and 1332.1ms.
Registration, enrollment, real playback, completion, fullscreen rotation,
and watermark visibility passed with no browser script errors. Production
also passed real playback and the three phone widths. Enrollment refreshes
the bootstrap response immediately, including for a previously empty library.

Deploy by backing up SQLite, updating the checked revision, and restarting
`courseforge.service` and `courseforge-academy-worker.service`. Leave the tunnel
running. Asset version 15 invalidates previous page bundles.

## Phase 2: mobile-first foundation

- **Responsive audit across 320px, 390px, and 768px viewports**:
  - Eliminated horizontal scroll and cramping across all primary learner screens: Dashboard, Today's Plan, Library, Learning Studio, Lesson Sidebar, Lesson List, Lesson Materials panel, Notes, Assessments, and Settings.
- **Player Ergonomics & Touch Targets (≥ 44px)**:
  - Central play button formatted with a minimum 52px touch area.
  - Playback speed menu options formatted to ≥ 44×44px touch targets in a 4-column mobile grid.
  - Persistent floating next-lesson button (`.mobile-next`) fixed in the natural bottom-right thumb zone with 48px touch height.
  - Landscape orientation handling (`max-height: 500px`) automatically grants maximum viewport height (100dvh) to the video stage while auto-hiding navigation tabs.
- **Thumb-Zone Navigation**:
  - 5 thumb tabs (`dashboard`, `library`, `planner`, `tutor`, `reviews`) featuring dedicated vector icons and safe-area padding.
  - Left edge-swipe gesture (`clientX <= 36`, horizontal drag ≥ 70px) transitions back from the player directly to the course library.
  - Studio breadcrumbs (`.crumb-link`) provide an accessible 36px+ tap target back to course overview.
- **One-Handed Lesson Materials**:
  - Materials cards format into high-contrast rows on mobile with a 46px tall primary download action (`.material-download-btn`) with native `download` attribute.
  - Inline browser preview formats without horizontal layout breakage on small viewports.
- **Fast 3G Performance Proof**:
  - Validated via Chrome DevTools Protocol (CDP) under throttled Fast 3G (1.6 Mbps down, 750 kbps up, 150ms RTT) and 4x CPU throttling: lesson page and materials panel reach full interactivity in ~700ms (threshold < 2,000ms).
- **Test Suite**:
  - 7/7 tests passing in `tests/test_phase2_mobile_foundation.py`.
  - 158/158 non-regression tests passing across the core suite.

## Phase 3: habit loop

Pending the next independently validated release (daily streak loop, return triggers, admin engagement metrics).

## Phase 4: learning that sticks

Pending instructor assessments and per-lesson active recall quizzes.

## Phase 5: proactive AI companion

Pending companion intelligence release.
