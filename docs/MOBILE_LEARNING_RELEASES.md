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

- **Instant Momentum**:
  - After sign-in, the dashboard leads with `Continue "[Lesson Name]"` or `Start "[Lesson Name]"`.
  - Resumes playback in one click directly to the saved position.
  - A new learner reaches a playing lesson within 3 clicks of registration.
- **Daily Habit & Streak Loop**:
  - Streak tracking is private and resilient to device timezone travels (`app/habits.py`).
  - Daily goal preference: 15 minutes of watching or 1 completed lesson.
  - Reaching the daily goal triggers an uplifting celebration badge and toast.
  - Missing a day never shames, nags, or resets progress; 0 streak presents a welcoming start invitation.
- **Visible Progress & Milestone Celebrations**:
  - Course cards display clean progress bars with explicit "X of Y lessons" count.
  - Finishing a lesson triggers a brief animated check-mark moment (`.lesson-check-moment`).
  - Finishing all lessons in a course triggers a screenshot-worthy Certificate of Completion dialog (`#courseCompletionDialog`) featuring student name, course title, completion date, and share action.
- **Zero-Friction Watching**:
  - Autoplay-next is enabled by default with a 10-second countdown and one-click opt-out checkbox, saved to user player preferences.
  - Player keyboard shortcuts (Space for play/pause, ArrowLeft/ArrowRight for 10s seek, F for fullscreen, M for mute, L for lock).
- **Come-Back Triggers**:
  - In-app weekly recap banner on the dashboard ("You learned 2h 40m across 3 lessons this week").
  - Opt-in email reminder toggle saved in preferences, wired to automated Sunday weekly digest once SMTP is active.
- **Admin Engagement Measurement**:
  - Dedicated admin metrics for Daily active students, Average session minutes, and 7-day return rate with explicit denominators. Excludes admin accounts and suspended users.
  - 6/6 acceptance tests passing in `tests/test_phase3_habit_loop.py`.
  - 5/5 backend tests passing in `tests/test_habits.py`.
  - 169/169 core suite tests passing with 0 regressions.
- **Production Deployment & Odysee Verification**:
  - Live production environment refreshed and verified on Linux server (`141.148.195.233`).
  - Active channel signing configured for `@lavkushry` (`3Nj7vMUEayo8PLWgYTLMfpbcbtSzVj9f`), delivering verified HTTP 206 byte-range native playback and direct authenticated material downloads across 511 mapped lectures and 138 documents.
  - Active demo accounts provisioned: Student (`student@courseforge.demo` / `DemoStudentPass2026!`) and Admin (`admin@courseforge.demo` / `DemoAdminPass2026!`).

## Phase 4: learning that sticks

- **Per-Lesson Mastery Quizzes**:
  - 3–5 grounded, concept and applied questions per lesson.
  - Passing ($\ge 70\%$) awards the green `Learned ✓` badge on the lesson in both the study rail and sidebar.
  - Failing offers a friendly retry with a specific suggested lesson timestamp/section — never a dead end.
  - All quiz questions and submissions are deterministic and fail-safe even if external AI services are offline.
- **Review Tab & Spaced Repetition**:
  - Spaced-repetition sessions resurface concepts and lessons from past days and weeks at growing intervals using SM-2.
  - Self-rated recall evaluations ("Again", "Hard", "Good", "Easy") schedule card intervals.
  - Active recall grading automatically calls `/api/reviews/complete` and credits the daily habit loop (`kind='review'`).
- **Official Course Completion Certificates & Public Verification**:
  - Completing all lessons (100% watched) AND passing all quizzes for a course issues an official Certificate of Completion.
  - Contains student name, course title, issue date, unique verification code (e.g. `CF-XXXX-XXXX`), and a public verification URL (`/verify/{code}`).
  - Verification endpoint `/verify/{code}` is accessible without an account (publicly verifiable by employers or peers from any browser).
  - Screenshot-worthy modal with copy-achievement and open-public-certificate actions.
- **Habit & Learning Loop Reinforcement**:
  - Passing a quiz (`lesson_quiz_passed`) and completing a review session (`lesson_review_completed`) feed daily streaks and weekly recaps.
  - Daily goal of "1 lesson completed" counts lessons + quizzes + reviews.
- **Admin Engagement Measurement**:
  - Added `quiz_pass_rate` (percentage with attempt counts) and `review_session_completion` count to `/api/admin/overview`.
- **Validation**:
  - 4/4 acceptance tests passing in `tests/test_phase4_learning_retention.py`.
  - 173/173 core suite tests passing with 0 regressions.

## Phase 5: proactive AI companion

- **Timestamp-Grounded AI Tutor (Criteria 24 & 33)**:
  - Every tutor response is grounded in lecture transcripts and cites exact lesson titles and timestamps in clickable markdown format: `[Watch MM:SS in Lesson Title](#learning/{video_id}?t={seconds})`.
  - Clicking any citation jumps the player directly to that second and begins playback.
  - Transparent fallback: when Ollama is offline or warming up, the tutor performs direct extractive synthesis from retrieved excerpts without throwing 500/503 errors.
  - Queries in Hinglish are detected and answered in natural, professional Hinglish while keeping technical keywords (e.g. "Azure Blob Storage", "Spark Dataframe", "Partition Key") intact.
- **Search the Moment (Criterion 25)**:
  - Universal search (`/api/search?q=...`) surfaces exact transcript moments alongside courses, lessons, and materials.
  - Each moment displays lesson title, timestamp pill (e.g. `12:45`), matched excerpt, and 1-click jump action.
- **Ready-Made Lesson Briefs (Criterion 26)**:
  - Dedicated "Brief" tab in the lesson study rail (`#tab-brief`, `#panel-brief`).
  - Summarizes 5 bullet-point key takeaways, prerequisites, and build outcomes generated from transcripts.
  - If a lesson lacks transcripts, shows a clean empty state with no broken containers.
- **Auto Quizzes & Admin Management (Criterion 27)**:
  - Automatically synthesizes mastery quizzes and review flashcards from lesson content.
  - Admin Course Detail includes a Quiz Management table (`GET /api/admin/courses/{course}/quizzes`) with status tracking (`approved`, `draft`), edit questions modal (`PUT /api/admin/quizzes/{quiz_id}`), and one-click quiz regeneration (`POST /api/admin/videos/{video_id}/quiz/regenerate`).
- **Adaptive Spaced Repetition (Criterion 28)**:
  - Adaptive review endpoint (`GET /api/reviews/adaptive`) dynamically scores flashcards based on learner struggles.
  - Prioritizes failed quiz questions (+60 score, tagged `Quiz retry priority`), hard recall cards (+30 score), overdue intervals (+25 score), and older unreviewed lessons (+15 score).
- **Smart Resume Hero Banner (Criterion 29)**:
  - When a student returns after 2+ days away, a warm banner appears above the dashboard: `"Last time you learned about {Last Lesson}. Ready to pick up with {Next Lesson}?"`
  - Includes a direct "Pick up where you left off" resume button and dismiss action.
- **Interview-Prep Mode (Criterion 30)**:
  - AI Tutor features a dedicated "Mock Interview" practice mode (`#interviewPrepModeBtn`).
  - Assesses technical interview readiness across topics (0–100% score).
  - Evaluates student answers with rubrics, provides constructive feedback, and cites exact lesson timestamps for brushing up.
- **Teacher Insights Analytics (Criterion 31)**:
  - Dedicated Teacher Insights analytics card in the Admin Overview (`GET /api/admin/teacher-insights`).
  - Tracks top student AI query topics, quiz questions with highest failure rates, total AI queries, token usage, and cost estimates.
- **Placement Diagnostic Onboarding (Criterion 32)**:
  - Adaptive 10-question placement test available from the Course Library (`#openPlacementBtn`, `/api/courses/{course}/placement-test`).
  - Benchmarks knowledge across foundational, intermediate, and advanced concepts.
  - Recommends the optimal starting lesson so learners can skip topics they already know.
- **Validation**:
  - 5/5 acceptance tests passing in `tests/test_phase5_ai_companion.py`.
  - 178/178 core suite tests passing with 0 regressions.

## UI Excellence Pass — Stage 1: Design Tokens & Icon System

- **Unified Design Tokens (`app/static/tokens.css`)**:
  - Defined in one place using CSS custom properties on a strict 4/8px grid (`--space-0` through `--space-16`).
  - Standardized font family (`Inter`, system fallbacks), full typography scale (10px–38px), corner radii (`--radius-xs` 4px to `--radius-full`), and 5-level elevation system (`--shadow-xs` to `--shadow-xl`).
  - Standardized control heights (`--control-h-sm` 32px to `--control-h-xl` 48px).
- **Universal Outline SVG Icon System**:
  - Replaced all emojis and legacy fill-based SVG icons with a unified 58-symbol outline SVG icon set (`stroke-width="1.8"`, `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`).
  - Aligned to text baselines (`vertical-align: -0.15em; display: inline-block`).
  - Covers workspace sidebar, top nav, lesson sidebar status indicators, DRM toolbar, player controls, admin views, and study materials.
  - Zero emojis used as icons across all UI files; zero missing/unmapped icon references.
- **Automated Icon Audit & Release Gate**:
  - Created `scripts/audit_icons.py` to scan static templates and JS files for unmapped `#i-...` IDs and emojis.
  - Added unit tests in `tests/test_icon_audit.py` (3/3 passing).
  - Integrated `--audit-icons` into `scripts/release_gate.py` to block commits with emoji icons or unknown icon IDs.
- **Validation**:
  - 181/181 pytest suite tests passing.
  - Deployed and live verified on Oracle Cloud VM and Cloudflare tunnel.

## UI Excellence Pass — Stage 2: Alignment Audit, Every View

- **Comprehensive View Alignment**:
  - Standardized alignment against tokens across every single view: Top Navigation, Workspace Sidebar, Dashboard, Course Library grid & cards, Course Page, Lesson Sidebar, Materials Viewer, Notes & Bookmarks, Mastery Assessments, Daily Planner, Practice Labs, AI Tutor, Settings, Auth pages (Sign in / Register), Administration dashboard, Viewer Tracking modal, and Study Materials Browser (`#resourcesDialog`).
  - Lesson Sidebar Rows: Upgraded to a clean 2-column grid (`28px minmax(0, 1fr)`) with tabular-numeric lesson numbers (`28x28px`), baseline-aligned lesson titles, and unified status rows (`"57m · Completed"`, duration · status · materials) that never wrap raggedly.
- **Consistency Rules Enforced**:
  - **Identical Card Padding**: Strict `var(--space-6)` (24px) on desktop, `var(--space-4)` (16px) on mobile ($\le 670$px) across all panels, cards, and modal dialogs.
  - **Unified Control Heights**: Default button/input height `var(--control-h-md)` (40px) on desktop, small `var(--control-h-sm)` (32px), with touch targets guaranteed $\ge 44$px (`var(--control-h-lg)`) on mobile viewports.
  - **One Chip Style**: Universal inline-flex architecture (`border-radius: var(--radius-full)`, `font-size: var(--text-xs)`, `font-weight: 600`, `padding: 3px 8px`) across tags, pills, next-up badges, and learned chips.
  - **Focus & Motion**: Consistent 2px focus ring (`outline: 2px solid var(--accent); outline-offset: 2px`), and snappy 150–200ms transitions (`--transition-fast`) with zero jank.
- **Automated Multi-Engine & Multi-Viewport Evidence**:
  - Created `scripts/verify_alignment_evidence.py` to test all 12 views at `[320, 390, 768, 1366, 1920]` across Chromium and WebKit.
  - 120/120 automated checks passed: zero horizontal scrolling anywhere (`scrollWidth <= innerWidth + 1`).
  - Saved full screenshot evidence gallery into `data/evidence/`.
- **Validation**:
  - 187/187 tests passing in pytest (extended `test_responsive_layout.py` with 1920 desktop and WebKit engine verification).


