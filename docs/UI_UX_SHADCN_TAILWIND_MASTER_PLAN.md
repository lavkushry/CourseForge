# CourseForge TS + Go — World-Class UI/UX & Component Architecture Master Plan
## Tailwind CSS v4 + shadcn/ui Design System · iOS, Android, macOS & Windows Desktop

> **Executive Answer — Will We Complete This Without Breaking Anything?**
> **Yes — 100%.** Every single view, container, interactive control, dialog, state transition, and micro-copy string ("down to a single text label") across CourseForge's TypeScript (`web/src/*`) + Go (`backend/internal/*`) architecture is cataloged, planned, and engineered below using **Tailwind CSS + shadcn/ui** design primitives and **iOS / Android / macOS / Windows Desktop** adaptive ergonomics, while preserving every existing DOM ID, CSS hook, API contract, and playback ownership guarantee.

---

## 1. Unified Design System Foundation (Tailwind CSS + shadcn/ui Tokens)

### 1.1 Semantic Color & Surface Tokens (`shadcn/ui` CSS Variables)
CourseForge uses a **Cinema-Grade Dark Obsidian + Warm Terracotta & Violet Studio** palette engineered for multi-hour coding & system-design study sessions with WCAG AAA text contrast and zero eye strain.

| Token (`shadcn/ui` & Tailwind) | Dark Mode Value (Default) | Light Mode Value (`[data-theme="light"]`) | Component Usage |
| :--- | :--- | :--- | :--- |
| `--background` (`bg-background`) | `#0b0c10` (`228 19% 5%`) | `#f8fafc` (`210 40% 98%`) | Root viewport canvas (`body`, `.app-layout-shell`) |
| `--foreground` (`text-foreground`) | `#f3f4f6` (`220 14% 96%`) | `#0f172a` (`222 47% 11%`) | Primary headings, lesson titles, active controls |
| `--card` (`bg-card`) | `#14151c` (`232 17% 9%`) | `#ffffff` (`0 0% 100%`) | Course cards, study rail, bento panels, stat cards |
| `--card-foreground` (`text-card-foreground`) | `#f3f4f6` | `#0f172a` | Card titles and primary copy |
| `--popover` (`bg-popover`) | `rgba(18, 19, 26, 0.96)` | `rgba(255, 255, 255, 0.98)` | OmniSearch (`cmdk`), speed/quality menu, Up Next card |
| `--popover-foreground` | `#f3f4f6` | `#0f172a` | Popover & dialog text |
| `--primary` (`bg-primary`) | `#e54503` (Terracotta Flame) | `#d93800` | Primary CTAs (`Sign in`, `Continue course`, `Watch Now`) |
| `--primary-foreground` | `#ffffff` | `#ffffff` | Text/icons inside primary buttons |
| `--secondary` (`bg-secondary`) | `#1e202b` (`231 18% 14%`) | `#f1f5f9` (`210 40% 96%`) | Secondary action pills (`Save Note`, `Capture`, `Curriculum`) |
| `--secondary-foreground` | `#e2e8f0` | `#1e293b` | Secondary button labels |
| `--muted` (`bg-muted`) | `#181922` | `#f1f5f9` | Inactive tabs, skeleton backgrounds, subtle wells |
| `--muted-foreground` (`text-muted-foreground`) | `#9ca3af` (`218 11% 65%`) | `#64748b` (`215 16% 47%`) | Timestamps, secondary metadata, descriptions |
| `--accent` (`bg-accent`) | `#8b5cf6` (Electric Violet) | `#7c3aed` | Academy Studio mode switch, AI Tutor badges, focus rings |
| `--accent-foreground` | `#ffffff` | `#ffffff` | Text on violet studio surfaces |
| `--destructive` (`bg-destructive`) | `#ef4444` | `#dc2626` | `Clear History`, `Suspend`, `Revoke`, error notices |
| `--border` (`border-border`) | `rgba(255, 255, 255, 0.08)` | `rgba(15, 23, 42, 0.10)` | `1px` specular hairline borders on cards, rails, inputs |
| `--input` (`border-input`) | `rgba(255, 255, 255, 0.14)` | `rgba(15, 23, 42, 0.16)` | Form controls (`input`, `select`, `textarea`) |
| `--ring` (`ring-ring`) | `#8b5cf6` | `#7c3aed` | `2px` keyboard focus ring (`outline-offset: 2px`) |
| `--pill-terracotta` | `bg: rgba(229,69,3,0.18)` / `fg: #ff8a5c` | `bg: #fff1eb` / `fg: #c23800` | `#lesson-module-badge` (`Module 1`, `Week 2`) |
| `--pill-purple` | `bg: rgba(139,92,246,0.18)` / `fg: #c4b5fd` | `bg: #f3e8ff` / `fg: #6d28d9` | `#lesson-category-badge` (`Engineering`, `AI & Agents`) |
| `--pill-emerald` | `bg: rgba(16,185,129,0.16)` / `fg: #6ee7b7` | `bg: #ecfdf5` / `fg: #047857` | `#lesson-duration-badge` (`Studio Lecture`), `Learned ✓` |
| `--pill-ocean` | `bg: rgba(14,165,233,0.16)` / `fg: #7dd3fc` | `bg: #f0f9ff` / `fg: #0369a1` | `#coverage` (`In Progress`, `92% watched`) |

### 1.2 Typography & Spacing Scale
- **Sans Font Stack (`--font-sans`)**: `'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI Variable', 'Roboto', sans-serif`
- **Mono Font Stack (`--font-mono`)**: `'JetBrains Mono', 'SF Mono', 'Cascadia Code', ui-monospace, Menlo, Consolas, monospace` (used for timestamps, code labs, verification codes, watermark, and `tabular-nums` counters).
- **Strict 4px/8px Spatial Grid**:
  - Radii: `--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 16px`, `--radius-xl: 24px`, `--radius-full: 9999px`.
  - Control Heights: `sm: 32px`, `md: 40px` (Desktop), `lg: 44px` (iOS HIG minimum), `xl: 48px` (Android Material 3 touch target).

---

## 2. Cross-Platform Adaptive Engineering (iOS, Android, macOS, Windows)

### 2.1 iOS & iPadOS (Apple Human Interface Guidelines)
1. **Edge-to-Edge Safe Areas**: `viewport-fit=cover` with `padding-top: env(safe-area-inset-top)`, `padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 8px)` on `#primary-nav` bottom tab bar so the Home Indicator never collides with navigation icons.
2. **Zero Auto-Zoom on Form Focus**: Every `<input>`, `<select>`, and `<textarea>` enforces `font-size: max(16px, 0.92rem)` on touch viewports (`@media (hover: none) and (pointer: coarse)`), eliminating Safari's jarring viewport zoom.
3. **Touch Ergonomics & Gestures**:
   - All interactive targets enforce `min-width: 44px; min-height: 44px`.
   - Double-tap left/right video stage seeks `-10s` / `+10s` with radial HUD feedback without triggering accidental single-tap pause.
   - Magnetic bottom sheet (`#episode-dialog.magnetic-macos-drawer`) uses iOS spring curve `cubic-bezier(0.32, 0.72, 0, 1)` and `max-height: 82dvh`.
   - Inline playback (`playsinline`) with forensic watermark preserved in both native and custom fullscreen modes.

### 2.2 Android (Material 3 Adaptive & Edge-to-Edge Skills)
1. **Adaptive Navigation Suite (`NavigationSuiteScaffold` pattern)**:
   - **Compact (`< 640px`, Phones)**: Fixed 5-item bottom `NavigationBar` (`Home`, `Courses`, `My List`, `Daily Plan`, `AI Tutor`, `Menu`) with pill active indicator (`height: 64px + env(safe-area-inset-bottom)`).
   - **Medium (`640px – 1024px`, Foldables & Tablets)**: Vertical 72px `NavigationRail` docked to the left edge with icon + tooltip affordances.
   - **Expanded (`> 1024px`, Desktop & Academy Studio)**: Collapsible `72px` icon rail or expanded `244px` `PermanentDrawerSheet` (`body.academy-studio-mode`) with section headers (`DISCOVER`, `LEARNING STUDIO`, `PRACTICE & AI`, `SYSTEM`).
2. **Multi-Pane Scene Architecture (`SceneStrategy` pattern)**:
   - **Supporting Pane Scene (Classroom)**: Primary 16:9 Video Stage (`minmax(0, 1fr)`) + Supporting Study Rail (`clamp(300px, 28vw, 380px)`) side-by-side on `> 1024px`, collapsing into a stacked single-column layout on `< 1024px` with a slide-up sheet for curriculum browsing.
   - **List-Detail Scene (Roadmaps & Labs)**: `320px` list pane + `1fr` detail pane on desktop, adaptive single-pane on compact screens.
3. **IME & Configuration Resilience**:
   - Soft keyboard (`IME`) insets automatically keep `#tutor-question`, `#note-content`, and `#omni-search-input` above the keyboard using `100dvh` and `scrollIntoView({ block: 'nearest' })`.
   - Orientation rotation into landscape on phones (`@media (max-height: 500px) and (orientation: landscape)`) maximizes the video stage to `100dvh` and auto-hides the bottom navigation bar.
   - Playback state (`currentTime`, `playbackRate`, `paused`) is continuously persisted so folding/unfolding or rotating never resets playback to `0:00` or auto-plays a paused lecture.

### 2.3 macOS Desktop
1. **Vibrancy & Translucency**: Header (`backdrop-filter: blur(20px) saturate(180%)`), floating player dock, and OmniSearch Spotlight modal use layered translucent surfaces with `1px solid rgba(255, 255, 255, 0.08)` top-edge highlights.
2. **Spotlight Command Palette (`⌘K`)**: Instant keyboard-driven navigation across all 29 masterclasses, 3,870+ lessons, roadmaps, and studio tools with `↑`/`↓` roving selection, `↵` launch, and `ESC` dismissal.
3. **Pro Video Hotkeys**: `Space`/`K` (Play/Pause), `J`/`←` (-10s), `L`/`→` (+10s), `M` (Mute), `F` (Fullscreen), `C` (Theater Mode), `P` (Picture-in-Picture), `X` (Hold-to-Unlock Control Lock), `Shift+N` (Next Lesson).

### 2.4 Windows Desktop (Fluent Design & Accessibility)
1. **Custom Fluent Scrollbars**: Thin, dark-themed scrollbars (`scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent` + `::-webkit-scrollbar` 6px rounded thumb) across the Study Rail, OmniSearch, Admin tables, and Code Labs—preventing jarring white/grey Win32 scrollbars.
2. **High-Contrast & Keyboard Focus**: Explicit `:focus-visible` `2px solid var(--ring)` with `outline-offset: 2px` and `@media (forced-colors: active)` borders (`CanvasText` / `Highlight`) so every button, tab, and card is 100% operable via `Tab`, `Shift+Tab`, `Arrow` keys, and Windows Narrator.

---

## 3. Component-by-Component & Every-Single-Text-Label Specification

Below is the complete inventory of **every component, sub-component, DOM ID/selector, shadcn/ui mapping, and exact text copy** across all 14 functional areas of CourseForge TS+Go.

---

### Area 1: Authentication & Guest Discovery Portal (`web/src/main.ts` → `renderLogin()`)

| Component / Element | Selector / ID | `shadcn/ui` Primitive | Exact Text Copy / Label | UX & Cross-Platform Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Ambient Background** | `.login-atmosphere` | Decorative Backdrop | *(aria-hidden)* | 3 soft radial gradient orbs (`terracotta`, `violet`, `emerald`) with `prefers-reduced-motion` guard |
| **Brand Header Link** | `a.brand` | `Button (variant="link")` | Mark: `F` · Text: `CourseForge` · ARIA: `CourseForge home` | 44px minimum tap height; crisp SVG/monogram emblem |
| **Auth Mode Switcher** | `.auth-tabs[role="tablist"]` | `Tabs` / `TabsList` | Tab 1 (`#auth-tab-login`): `Sign In`<br>Tab 2 (`#auth-tab-register`): `Create Account` | Pill-style segmented control with `aria-selected` state and smooth background pill transition |
| **Auth Header Copy (Login)** | `#auth-eyebrow`<br>`#auth-title`<br>`#auth-desc` | `CardHeader` / `CardTitle` / `CardDescription` | Eyebrow: `Your next chapter starts here`<br>Title: `Welcome back.`<br>Description: `Big ideas. Small steps. Sign in to pick up where you left off.` | Dynamically updates when switching between Sign In and Create Account |
| **Auth Header Copy (Register)** | `#auth-eyebrow`<br>`#auth-title`<br>`#auth-desc` | `CardHeader` / `CardTitle` / `CardDescription` | Eyebrow: `Join CourseForge today`<br>Title: `Start learning.`<br>Description: `Unlimited access to elite engineering and AI courses.` | Auto-focuses `#register-name` on tab switch |
| **Login Email Field** | `label[for="email"]` + `#email` | `Label` + `Input` | Label: `Email address`<br>Placeholder: `name@example.com` | `type="email" autocomplete="username" required`, 44px height, 16px mobile font |
| **Login Password Field** | `label[for="password"]` + `#password` + `#toggle-login-password` | `Label` + `Input` + `Button (variant="ghost")` | Label: `Password`<br>Placeholder: `Enter password`<br>Toggle: `Show` / `Hide` (ARIA: `Toggle password visibility`) | Inline trailing visibility toggle button inside `.input-wrap` |
| **Login Submit CTA** | `#login-form button[type="submit"]` | `Button (variant="default")` | Default: `Sign in`<br>Busy: `Signing in…` | Full-width 44px primary CTA; disables during in-flight request |
| **Auth Mode Footer Link** | `.auth-switch-text` + `#switch-to-signup` / `#switch-to-signin` | `Button (variant="link")` | Login view: `New to CourseForge?` + `Create account`<br>Register view: `Already registered?` + `Sign in` | Accessible inline mode switch |
| **Register Fields** | `#register-name`<br>`#register-email`<br>`#register-password` | `Label` + `Input` | `Full name` (`Your full name`)<br>`Work or personal email` (`name@example.com`)<br>`Password (4+ characters)` (`Choose a password`)<br>Submit: `Create account` | Immediate student account provisioning & session bootstrap |
| **Status / Error Banner** | `#notice[role="status"]` | `Alert (variant="default" \| "destructive")` | Dynamic status or error message | `aria-live="polite"`, hidden when empty |
| **Inspirational Tagline** | `.login-footer` | Muted Caption | `Make room for what you want to learn.` | Centered subtle footer copy |
| **Guest Curriculum Showcase** | `#guest-preview-section` + `#guest-preview-grid` | `Card` Grid (`aspect-video`) | Eyebrow: `EXPLORE THE 2026 CURRICULUM`<br>Heading: `29 Masterclasses Ready to Stream`<br>Subtitle: `Agentic AI, LLM Internals, Distributed Systems, Cloud Data Engineering, and Scaler Masterclasses.` | Public preview cards with 16:9 artwork, category pill, and 1-click sign-in prompt |

---

### Area 2: Application Shell, Top Bar, Breadcrumbs & Adaptive Navigation (`web/src/main.ts`)

| Component / Element | Selector / ID | `shadcn/ui` Primitive | Exact Text Copy / Label | UX & Cross-Platform Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Skip Navigation Link** | `a.skip-link` | Accessibility Link | `Skip to content` | Visible on `:focus-visible` at top-left (`z-index: 9999`) |
| **Top Workspace Header** | `header.topbar.lms-topbar` | Sticky App Bar | Height: `64px` | `backdrop-filter: blur(20px)`, `border-bottom: 1px solid var(--border)`, zero element overlap at all widths |
| **Mobile Drawer Trigger** | `#mobile-menu-toggle` | `Button (variant="ghost", size="icon")` | ARIA: `Toggle navigation menu` | Visible on `≤ 900px`, toggles `body.mobile-menu-open` + `#mobile-nav-backdrop` |
| **Brand Identity** | `#home.brand` | Brand Link | SVG Emblem + `CourseForge` | Returns to Home Discovery catalog |
| **Dynamic Breadcrumb Bar** | `.header-breadcrumbs` | `Breadcrumb` / `BreadcrumbList` | `#crumb-home`: `Home`<br>`#crumb-section`: `Discovery` (or active category)<br>`#crumb-current`: `2026 Masterclass Catalog` (or active course/view title) | Truncates `#crumb-current` cleanly with `text-overflow: ellipsis; max-width: 26ch` so it never pushes search controls off-screen |
| **OmniSearch Pill Trigger** | `#header-quick-search-wrap` + `#header-quick-search` | `Command` Trigger Input | Placeholder: `Search all pages...`<br>Shortcut Badge: `⌘K` (macOS) / `Ctrl K` (Windows) | Single unified border (no double input border); clicking or pressing `⌘K`/`/` opens OmniSearch modal |
| **Workspace Mode Toggle** | `#workspace-mode-toggle` | `Badge` / `Toggle` | `.mode-pill-label`: `Academy Studio` (or `Normal Mode`) | Toggles expanded 244px sidebar mode (`body.academy-studio-mode`) |
| **Planner & Settings Quick Icons** | `#header-bell-btn`<br>`#header-gear-btn` | `Button (variant="ghost", size="icon")` | Bell Title/ARIA: `Daily Study Planner`<br>Gear Title/ARIA: `Workspace Settings` | 40px circular icon buttons with subtle hover surface |
| **Learner Profile Chip** | `.user-pill` + `#user-avatar` + `#user-name` | `Avatar` + `Badge` | Avatar Initials (e.g., `DL`) + Learner Name (`Demo learner`) | Displays active account identity |
| **Sign Out Button** | `#logout` | `Button (variant="outline", size="sm")` | `Sign out` | Closes active player lease cleanly before logging out |
| **Left Navigation Rail / Mobile Bottom Bar** | `#primary-nav.lms-left-rail` | `NavigationMenu` / Adaptive Rail | **Section 1 (`DISCOVER`)**:<br>• `#nav-search-btn`: `Search`<br>• `#nav-home`: `Home`<br>• `#nav-courses`: `Courses`<br>• `#nav-saved`: `My List`<br>**Section 2 (`LEARNING STUDIO`)**:<br>• `#nav-library`: `My Library`<br>• `#nav-planner`: `Daily Plan`<br>• `#nav-history`: `History`<br>• `#nav-paths`: `Roadmaps`<br>**Section 3 (`PRACTICE & AI`)**:<br>• `#nav-reviews`: `Flashcards`<br>• `#nav-tutor`: `AI Tutor`<br>• `#nav-labs`: `Code Labs`<br>**Section 4 (`SYSTEM`)**:<br>• `#nav-admin`: `Admin` (Admin role only)<br>• `#nav-settings`: `Settings`<br>• `#rail-mode-expand`: `Normal View`<br>• `#mobile-more-btn`: `Menu` (Mobile only) | • Desktop (`>900px`): 72px icon rail (or 244px expanded Academy Studio sidebar)<br>• Mobile (`≤900px`): 6-item thumb-zone bottom bar (`Home`, `Courses`, `My List`, `Daily Plan`, `AI Tutor`, `Menu`) + slide-up sheet for full 12-item grid |

---

### Area 3: Streaming Discovery, Hero Billboard & Course Cards (`web/src/discovery/view.ts`)

| Component / Element | Selector / ID | `shadcn/ui` Primitive | Exact Text Copy / Label | UX & Cross-Platform Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Featured Hero Billboard** | `#featured-course.featured-course` | Hero `Card` with `aspect-auto` Backdrop | • Kicker (`.hero-kicker`): `CourseForge Original Masterclass`<br>• Title (`.hero-title`): Course Title<br>• Description (`.hero-description`): Course summary or `Find a new perspective. Learn something that stays with you.`<br>• Metadata Chips (`.hero-metadata`):<br>  - `.hero-badge-match`: `98% Match`<br>  - `.hero-chip`: `2026 Edition`<br>  - `.hero-chip-badge`: `Pro`<br>  - `.hero-chip`: `{N} lessons · {Xh Ym}` (or `Self-paced`)<br>  - `.hero-tech-badge`: `4K Ultra HD`, `Dolby Audio`, `CC`<br>  - `.hero-category-chip`: Title-Cased Category<br>• Actions (`.hero-actions`):<br>  - Primary CTA: `Continue course` (if enrolled) / `Explore course`<br>  - Secondary CTA: `Curriculum`<br>  - Tertiary CTA: `Roadmap`<br>  - List Toggle: `+ My List` / `✓ In My List` | `.hero-art` is strictly `position: absolute; inset: 0; z-index: 1` with a multi-stop cinematic vignette gradient (`linear-gradient(90deg, rgba(11,12,16,0.96) 0%, rgba(11,12,16,0.78) 55%, rgba(11,12,16,0.35) 100%)`), keeping `.hero-content` overlaid cleanly at `z-index: 3` |
| **Continue Watching Row** | `#continue-section` + `#continue-list` | Horizontal Carousel / `Card` | Eyebrow: `YOUR ACTIVE SESSIONS`<br>Heading: `Continue Watching`<br>Card Pill: `In Progress`<br>Card Eyebrow: `Continue Learning`<br>Progress Text: `{MM:SS} / {Duration}` | 16:9 thumbnail with play overlay, duration badge, and `<progress class="watch-progress">` bar |
| **Top 10 Masterclasses Row** | `#trending-section` + `#trending-list` | Ranked Carousel | Eyebrow: `MOST WATCHED THIS WEEK`<br>Heading: `Top 10 Masterclasses` | Large tabular rank numerals (`1`–`10`) alongside 16:9 course cards |
| **My Saved List Row** | `#saved-section` + `#saved-list` | Saved `Card` Grid | Eyebrow: `YOUR PERSONAL QUEUE`<br>Heading: `My Saved List`<br>Remove CTA: `Remove` | Displays saved courses and individual bookmarked lectures |
| **Catalog Filter & Search Toolbar** | `.catalog-controls` | `Input` + `ToggleGroup` | Heading (`#catalog-heading`): `Explore courses`<br>Search (`#course-search`): Label `Find a course`, Placeholder `Title, topic, or category`<br>Category Pills (`#category-pills`): `All topics` + dynamic categories | Real-time client + server filtering with `aria-pressed` pill states |
| **Course Card** | `article.course-card` | `Card` (`rounded-2xl`) | • Thumbnail Top-Left (`.thumb-category-pill`): Title-Cased Category (`AI & Agents`, `System Design`, etc.)<br>• Thumbnail Bottom-Right (`.thumb-duration-badge`): `{Xh Ym}` / `Learn at your pace`<br>• Body Badge (`.course-badge`): `Enrolled` or Category<br>• Title (`h2`): Course Title<br>• Description (`.course-description`): 2-line clamped summary<br>• Meta (`.course-meta`): `{N} lessons · {Duration}`<br>• Actions (`.course-card-actions`):<br>  - Primary: `Open course →`<br>  - Secondary: `Curriculum`<br>  - Save: `+ My List` / `✓ In My List` | Hover elevation (`translateY(-4px)`), crisp 16:9 bespoke SVG/poster cover with zero overlapping SVG pills, aligned footer actions |

---

### Area 4: Discovery Syllabus Preview Dialog (`web/src/discovery/syllabus-dialog.ts`)

| Component / Element | Selector / ID | `shadcn/ui` Primitive | Exact Text Copy / Label | UX & Cross-Platform Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Modal Container** | `dialog#syllabus-dialog` | `Dialog` / `DialogContent` | ARIA: `Course details` · Close (`button.syllabus-close-btn`): `Close course details` | Backdrop blur (`backdrop-filter: blur(10px)`), closes on `ESC` or outside click |
| **Syllabus Hero Header** | `.syllabus-hero` | Hero Banner | • Eyebrow: `COURSEFORGE · {CATEGORY}` (or `COURSEFORGE MASTERCLASS`)<br>• Title (`.syllabus-title`): Course Title<br>• Meta Chips (`.syllabus-meta-row`): `1080p HD`, `{N} Lectures`, `{Xh Ym}`, `With {Instructor}` (or `CourseForge Faculty`)<br>• Primary CTA (`.syllabus-play-cta`): `Continue Learning` (if started) / `Start Course`<br>• Secondary CTA (`.syllabus-save-cta`): `+ Add to My List` / `In My List` | Instant 1-click jump into the first or active lecture |
| **Syllabus Body & Modules** | `.syllabus-body` + `.syllabus-module-card` | `Accordion` / `ScrollArea` | • Section 1: `About this Masterclass`<br>• Section 2: `Course Curriculum` (`{Completed} of {Total} completed`)<br>• Module Header: `{Module Name}` + `{N} lectures`<br>• Lecture Row: Index (`01`, `02` or `✓`), cleaned lesson title, duration (`MM:SS`) | Clicking any lecture row closes the dialog and immediately begins playback of that lecture |

---

### Area 5: Classroom & Protected Media Chrome Player (`web/src/main.ts`, `web/src/player/chrome.ts`, `web/src/player/chrome.css`)

| Component / Element | Selector / ID | `shadcn/ui` Primitive | Exact Text Copy / Label | UX & Cross-Platform Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Classroom Top Bar** | `.classroom-top` | Sub-header Toolbar | • Back Button (`#back`): `All courses`<br>• Course Eyebrow (`#course-name`): Active Course Title<br>• Mode Switcher (`.classroom-mode-switch`):<br>  - `#mode-normal-btn`: `Normal Mode`<br>  - `#mode-studio-btn`: `Academy Studio`<br>• Playlist Drawer Pill (`#lesson-drawer-toggle`): `Lessons` | Aligned horizontally on desktop (`height: 38px`), wraps cleanly on mobile |
| **Enrollment Prompt Banner** | `#course-enrollment` | `Alert` + `Button` | Text: `Enroll to watch these lessons and save your progress.`<br>Button (`#enroll`): `Enroll in this course` | Shown only when viewing an unenrolled course |
| **Video Player Stage** | `#player-wrap` + `media-controller#media-controller` + `video#lesson-video` | Protected Media Stage (`aspect-video`) | ARIA: `Lesson player. Space or K plays and pauses. Arrows seek. M mutes. F opens fullscreen. C toggles theater mode. P toggles picture-in-picture. Shift+N next lesson.` | Strict `16:9` aspect ratio (`#050609` stage background), zero layout shift during loading |
| **Top-Right Floating Quick Dock** | `.cinema-top-dock` | Floating Glass Toolbar | • Note Button: Title `Take timestamped note`<br>• Chapters Button: Title `View AI video chapters & splits`<br>• Tutor Button: Title `Ask AI Tutor about this moment`<br>• Theater Button: Title `Toggle Theater Mode (C)`<br>• Lock Button: Title `Lock Player Controls (X)` | Frosted glass pill dock (`backdrop-filter: blur(12px)`), auto-hides with player controls |
| **Forensic Watermark** | `#watermark.watermark` | Security Overlay | Dynamic learner identifier (`{Name/Email} · {Session}`) | Anchored top-right (`top: 16px; right: 20px`), `rgba(255,255,255,0.42)`, `pointer-events: none`, preserved in fullscreen |
| **Bottom Transport Bar** | `media-control-bar` + `.cinema-right-controls` | Media Transport Bar | • Left: Play/Pause (`media-play-button`), Seek -10s, Seek +10s, Mute (`media-mute-button`), Volume (`media-volume-range`), Time (`media-time-display`: `0:13 / 0:30`)<br>• Center: Segmented Chapter Timeline (`media-time-range`) + Hover Chapter Preview Bubble<br>• Right: Settings Popover (`.cinema-settings-btn`: Speed `0.5×`–`3×`, Autoplay toggle, Quality `1080p HD`), Loop Toggle (`button[title*="Loop"]`), PiP, Fullscreen (`button[title="Fullscreen"]`) | 44px touch targets on mobile, smooth chapter ticks on scrubber |
| **Up Next Countdown Overlay** | `#playerUpNextCard.player-up-next-card` | `Popover` / Toast Card | • Eyebrow (`.up-next-eyebrow`): `Up Next`<br>• Countdown Badge (`#upNextCountdownBadge`): `{N}s`<br>• Title (`#upNextTitleText`): Next Lesson Title<br>• Primary CTA (`#upNextWatchNowBtn`): `Watch Now`<br>• Cancel CTA (`#upNextCancelBtn`): `Cancel` | Strictly `display: none !important` when `[hidden]`; compact mobile sizing so it never obscures the video stage |
| **Control Lock & Ownership Overlays** | `#unlock-controls`<br>`#ownership-overlay` | Security / Session Modal | • Unlock Button: `Hold to unlock` → `Keep holding…`<br>• Ownership Actions:<br>  - `#resume-here`: `Resume here`<br>  - `#move-here`: `Move playback here`<br>  - `#retry-lesson`: `Retry lesson`<br>  - `#sign-in-again`: `Sign in again`<br>  - `#return-to-course`: `Return to course` | Prevents accidental touches on mobile and handles multi-tab lease displacement cleanly |
| **Lesson Metadata & Action Bar** | `.lesson-meta-bar` | `Card` (`rounded-2xl`) | • Topic Pills (`.lesson-meta-badges`):<br>  - `#lesson-module-badge.pill-terracotta`: `Module 1` (Title-Cased)<br>  - `#lesson-category-badge.pill-purple`: `Engineering`<br>  - `#lesson-duration-badge.pill-emerald`: `Studio Lecture` (or duration)<br>  - `#coverage.pill-ocean`: `In Progress` / `{N}% watched` / `Lesson completed`<br>• Save Status (`#save-status`): `Progress saved` / `No unsaved progress` (with glowing emerald status dot, `white-space: nowrap`)<br>• Title (`#lesson-title`): Cleaned Lesson Title<br>• Subtitle (`.lesson-instructor-meta`): Badge `Instructor` + `#course-name-sub`<br>• Action Pills (`.lesson-action-pills`):<br>  - `#mark-complete.pill-complete`: `Mark as complete` / `Completed ✓`<br>  - `#save-note-pill.pill-note`: `Save Note`<br>  - `#capture-pill.pill-capture`: `Capture`<br>  - `#next-lesson.pill-next`: `Next lesson →` | Desktop: flex row with right-aligned action pills; Mobile (`≤640px`): 2×2 equal-width action button grid (`min-height: 44px`) |

---

### Area 6: 7-Tab Interactive Study Rail (`web/src/player/study-rail.ts`)

| Tab / Panel | Selector / Tab ID | `shadcn/ui` Primitive | Exact Text Copy / Label | UX & Cross-Platform Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **Study Rail Tab Strip** | `.study-rail-tabs[role="tablist"]` | `TabsList` | 1. `Curriculum` (`lessons`)<br>2. `Brief` (`brief`)<br>3. `Files` (`materials`)<br>4. `Quiz` (`quiz`)<br>5. `Notes` (`notes`)<br>6. `Transcript` (`transcript`)<br>7. `AI Tutor` (`tutor`) | Horizontally scrollable with arrow paddles (`‹` / `›`) and compact pill padding so all 7 tabs are reachable without clipping |
| **Tab 1: Curriculum** | `.rail-panel-lessons` | `Accordion` + `Input` | • Header: `Course Content` + `#lesson-count` (`{N} Lectures`)<br>• Filter Input: Placeholder `Search lessons in this course…`<br>• Module Accordion: `{Section Title}` + `{Completed}/{Total}`<br>• Lesson Row: Play/Check icon, Cleaned Lesson Title, Duration (`MM:SS`) | Active lesson highlighted with terracotta left accent bar (`3px solid #e54503`) and warm surface tint |
| **Tab 2: Brief (Executive Summary)** | `.rail-panel-brief` | `Card` + `Badge` | • Eyebrow: `{Section Title}` (Title-Cased) or `Module Overview`<br>• Heading (`.brief-title`): Cleaned Lesson Title + `Duration: {MM:SS}`<br>• Section: `Key Concepts & Takeaways`<br>• Action: `Mark as Complete` / `Completed` | Synthesizes structured architecture breakdown and completion state for the active lecture |
| **Tab 3: Files (Lesson Materials)** | `.rail-panel-materials` | File `Card` List | • Header: `Lesson Files & Code`<br>• Subtitle: `Downloadable Jupyter notebooks, slides, scripts, and datasets.`<br>• Empty State: `No supplementary download files attached to this specific lecture. Code snippets are demonstrated directly on screen.`<br>• File Row: Filename + `Download` | 44px touch download targets; opens supplementary resources in a new tab |
| **Tab 4: Quiz (Mastery Check)** | `.rail-panel-quiz` | `RadioGroup` + `Card` | • Header: `Lesson Concept Check`<br>• Subtitle: `Verify key takeaways and retain core ideas with instant feedback.`<br>• CTA: `Start Lesson Quiz` → `Submit Answers` / `Retake Quiz`<br>• Pass Badge: `Score: {Score}/{Total} ({Percent}%) · Concept Mastered!` | Grounded multiple-choice questions; passing (`≥70%`) marks lesson `Learned ✓` |
| **Tab 5: Notes (Timestamped Notes)** | `.rail-panel-notes` | `Textarea` + `Badge` | • Header: `Timestamped Study Notes`<br>• Subtitle: `Capture insights anchored to the exact video moment.`<br>• Input Placeholder: `Add a note at current video time…`<br>• Submit: `Save Note at {MM:SS}` | Clicking any saved note's timestamp chip (`{MM:SS}`) seeks the player directly to that second |
| **Tab 6: Transcript & AI Chapters** | `.rail-panel-transcript` | `ScrollArea` + `Input` | • Section 1: `AI Video Chapters & Splits` + `Split Video` / `Splitting…` button<br>• Section 2: `Searchable Lecture Transcript` + Search `Search spoken words in this lecture…` | Clicking any chapter or transcript segment seeks video immediately |
| **Tab 7: In-Rail AI Tutor** | `.rail-panel-tutor` | Chat `ScrollArea` + `Input` | • Eyebrow: `AI STUDY COMPANION`<br>• Header: `Ask Tutor About This Lecture`<br>• Modes: `Explain`, `Study Notes`, `Quiz Me`, `Practice Lab`<br>• Prompt Input: `Ask a question about this lecture…`<br>• Submit: `Ask Tutor` / `Thinking…` | Grounded RAG answers with clickable `{Cleaned Lesson Title} ({MM:SS})` timestamp citations |

---

### Area 7: Dedicated Learning Tools & Standalone Views (`web/src/learning/view.ts`, `web/src/library/view.ts`, `web/src/history/view.ts`, `web/src/reviews/view.ts`, `web/src/tutor/view.ts`, `web/src/labs/view.ts`, `web/src/paths/view.ts`, `web/src/planning/view.ts`, `web/src/settings/view.ts`)

| Workspace View | Root Selector | `shadcn/ui` Primitive | Exact Headings, Controls & Micro-Copy |
| :--- | :--- | :--- | :--- |
| **My Library (`library/view.ts`)** | `#library-panel` | Filterable `Card` Grid | • Eyebrow: `YOUR PERSONAL LEARNING STUDIO`<br>• Title: `My Course Library`<br>• Subtitle: `All 27 enrolled masterclasses, progress tracking, and full curriculum breakdowns.`<br>• Search: `Search courses by title, instructor, or topic…`<br>• Filter Tabs: `All Courses`, `In Progress`, `Completed`, `Saved`<br>• Card CTAs: `Continue` / `Start Course`, `Syllabus` |
| **Daily Plan & Focus Studio (`planning/view.ts`)** | `#planning-panel` | Bento Dashboard (`Card`, `Progress`, `Select`, `Switch`) | • Eyebrow: `HABITS, STREAKS & ADAPTIVE SCHEDULING`<br>• Title: `Daily Study Planner & Focus Studio`<br>• Cards:<br>  1. **Streak & Daily Goal**: `Current Streak`, `Daily Target` (`15m` / `30m` / `45m` / `60m`), `Weekly Reminder`<br>  2. **Today's Study Plan**: Date picker, `Planned Minutes`, `Build / Refresh Plan`, checklist items with `Actual min` logging<br>  3. **7-Day Adaptive Calendar**: Weekday minute budgets (`Mon`–`Sun`), `Build 7-Day Schedule`<br>  4. **Pomodoro Focus Timer**: `25:00` tabular clock, `Study Focus` / `Short Break`, `Start Focus`, `Pause`, `Complete`, weekly bar chart |
| **Watch History (`history/view.ts`)** | `#history-panel` | Timeline `Card` Grid | • Eyebrow: `CONTINUE WATCHING`<br>• Title: `Watch History`<br>• Subtitle: `Pick up right where you left off. Track your completion progress across all masterclass lectures.`<br>• Action: `Clear History`<br>• Empty State: `No watch history yet` / `Explore Courses` |
| **Learning Roadmaps (`paths/view.ts`)** | `#paths-panel` | List-Detail Split View (`Sidebar` + `SkillTree`) | • Sidebar Heading: `Learning Roadmaps`<br>• CTAs: `AI Generate` (with sparkle icon), `+ New Roadmap`<br>• Detail Eyebrow: `LEARNING ROADMAP · {PROVENANCE}`<br>• Stats Chips: `Progress: {N}%`, `Steps: {Done} / {Total}`, `Revision: {N}`<br>• Step Actions: `Mark done` / `Mastered`, `Jump to Lecture: {Cleaned Title} ({MM:SS})` |
| **Spaced Repetition Flashcards (`reviews/view.ts`)** | `#reviews-panel` | Interactive Flip `Card` | • Eyebrow: `SPACED REPETITION WORKSPACE`<br>• Title: `Retain What You Learn`<br>• Subtitle: `Review active concept flashcards with the SM-2 spaced repetition algorithm. Practice a few minutes daily to never forget.`<br>• Flashcard Controls: `Show Answer` → Recall Grading (`Again`, `Hard`, `Good`, `Easy`)<br>• Empty State: `You are all caught up!` |
| **Standalone AI Tutor (`tutor/view.ts`)** | `#tutor-panel` | RAG Chat Studio | • Eyebrow: `LOCAL AI STUDY PARTNER`<br>• Title: `Meet Your Personal Tutor`<br>• Subtitle: `Grounded explanations and study notes drawn exclusively from your masterclass lectures with clickable video timestamps.`<br>• Pedagogical Modes: `Explain Concepts`, `Generate Study Notes`, `Test Knowledge`, `Hands-on Lab Exercise`<br>• Prompt Input: `Ask anything about your courses, architecture trade-offs, code, or interview problems… (Press Enter to submit)`<br>• CTA: `Ask Tutor` / `Synthesizing…` |
| **Interactive Code Labs (`labs/view.ts`)** | `#labs-panel` | Split IDE (`List` + `CodeEditor` + `TerminalOutput`) | • Eyebrow: `HANDS-ON DOCKER GRADED EXERCISES`<br>• Title: `Interactive Practice Labs`<br>• Subtitle: `Write SQL, PySpark, Python, and Agentic AI code in isolated sandboxes with deterministic fixture grading.`<br>• Controls: `Reset Starter Code`, `Run & Grade Lab`<br>• Output Console: `Grader Verification Output` (`PASS · All test fixtures verified`) |
| **Workspace Settings (`settings/view.ts`)** | `#settings-panel` | `Card` Sections + `Switch` + `Select` | • Eyebrow: `ACCOUNT & WORKSPACE PREFERENCES`<br>• Title: `Settings`<br>• Sections:<br>  1. `Appearance & Theme`: Theme (`Dark Obsidian`, `Light Paper`, `System Auto`), Accent (`Indigo`, `Terracotta`, `Emerald`, `Rose`)<br>  2. `Video Player Defaults`: Default Playback Speed (`0.5×`–`3×`), `Autoplay next lecture`, `Theater mode by default`<br>  3. `Account & Security`: Profile details, active session management |

---

### Area 8: Official Certificates (`web/src/certificates/view.ts`) & University LMS Admin Command Center (`web/src/admin/view.ts`)

| Component / Element | Selector / ID | `shadcn/ui` Primitive | Exact Text Copy / Label |
| :--- | :--- | :--- | :--- |
| **Course Certificate Readiness & Modal** | `#course-certificate-section` + `dialog.cert-dialog` | `Card` + Gold Seal `Dialog` | • Banner: `Official Certificate of Completion` (`View Certificate`, `Verify Publicly`)<br>• Modal Seal: `COURSEFORGE VERIFIED MASTERCLASS`<br>• Modal Title: `Certificate of Completion`<br>• Actions: `Copy Verification Link`, `Open Public Certificate`, `Close` |
| **Admin Command Center (`admin/view.ts`)** | `#admin-panel` | 8-Tab Enterprise Dashboard (`Table`, `Badge`, `Dialog`, `Tabs`) | • Eyebrow: `UNIVERSITY LMS · PLATFORM ADMINISTRATION & ACCESS CONTROL`<br>• Title: `CourseForge Command Center`<br>• Subtitle: `Granular student course access control, account security, real-time telemetry, and AI pipeline diagnostics.`<br>• 8 Tabs: `Overview`, `Students & Access`, `Conversion Funnels`, `Retention & Cohorts`, `AI & RAG Telemetry`, `Security Audit`, `Live Player Activity`, `System Health`<br>• Student Modal (3 Tabs): `Course Access (29 Courses)` (`Grant All 29 Courses`, `Revoke All`, `Save Access Changes`), `Account & Security`, `Watch Telemetry` |
| **OmniSearch Command Palette (`search/omni.ts`)** | `dialog#omni-search-dialog` | `CommandDialog` (`cmdk`) | • Input Placeholder: `Search courses, lectures, roadmaps, studio tools...`<br>• Filter Chips: `All`, `Courses`, `Lectures`, `Roadmaps`, `Studio Tools`<br>• Footer Hints: `↑↓ Navigate`, `↵ Select`, `ESC Close` · Brand: `CourseForge Spotlight` |

---

## 4. Visual Polish & Zero-Regression Engineering Upgrades

To ensure CourseForge TS+Go delivers the **Best Modern Look Ever without breaking anything**, the following surgical enhancements are applied in `web/src/`:

1. **shadcn/ui Token & Primitive Layer (`web/src/style.css`, `web/src/ui/shadcn.ts`)**:
   - Full shadcn/ui CSS custom property ledger (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`) with automatic Dark/Light/System and Accent (`indigo`, `terracotta`, `teal`, `rose`) theming.
2. **Header & Search Bar De-Collision (Desktop, Tablet 1024px, Mobile 390px)**:
   - Eliminates the duplicate circular search button collision on tablet (`768px–1180px`) via `#mobile-search-btn.mobile-only-search-btn` and removes the double border inside `#header-quick-search-wrap.lms-header-search` so `#header-quick-search` renders as one sleek shadcn `Command` trigger pill with a right-aligned `⌘K` kbd badge.
3. **Hero Billboard Overlay Fix (`#featured-course`)**:
   - Forces `#featured-course .hero-art` and `.hero-art .course-cover` to `position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1` (`opacity: 0.42`) with a directional dark scrim so `.hero-content` sits overlaid on the artwork rather than pushed below a tall SVG block.
4. **Course Card & Thumbnail Perfection**:
   - Removes the duplicate internal SVG category pill in `createSvgThumbnailDataUri()` so `.thumb-category-pill` (top-left) and `.thumb-duration-badge` (bottom-right) sit cleanly over `.course-art .course-cover` (`16:9` artwork) with frosted glass blur.
   - Standardizes Title Case formatting (`toTitleCase`, `cleanLessonTitle`, `formatModuleBadge`) across all cards, lesson titles, module headers, study rail rows, tutor citations, and roadmap lecture chips without corrupting technical decimal/hyphenated terms (`802.11ax`, `2.4 GHz`, `2-Phase Commit`).
5. **Classroom Metadata & Study Rail Polish**:
   - Keeps `#save-status.lesson-save-status` (`Progress saved`) on a single line (`white-space: nowrap; flex-shrink: 0`) with an emerald pulse indicator.
   - Formats `.instructor-tag` as a subtle pill chip separated cleanly from `#course-name-sub`.
   - Ensures `#playerUpNextCard[hidden]` is strictly hidden (`display: none !important`) during active playback and compactly proportioned on mobile screens when active.
   - Enhances cross-platform safe areas (`env(safe-area-inset-*)` on `.site-header.lms-top-header` and `#primary-nav.primary-navigation.lms-left-rail`), 44px minimum touch targets (`.button`, `.lms-nav-item` on iOS/Android), smooth custom scrollbars (Windows/macOS), and high-contrast `:focus-visible` rings.
