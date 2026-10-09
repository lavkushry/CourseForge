# CourseForge v3 UI — Design system and user experience

## Product direction

This interface serves a **single-user, local-first learning library**. It borrows established LMS conventions—course cards, clear completion indicators, curriculum sidebar, timestamps, and resume playback—without reproducing Coursera or Udemy brands, designs, proprietary media, or online catalogs.

**It does not import purchased courses from Coursera/Udemy automatically**: the original media must already be stored locally and user-authorized. It does not issue Coursera/Udemy certificates or synchronize their cloud progress.

## Core navigation

| View | Purpose |
|---|---|
| Overview | Visual stats, course continuation, AI and practice entry points |
| My library | Course cards, status filters, search by course/lesson title, scan control |
| Learning room | Native video player, resume position, indexed segments and curriculum sidebar |
| AI tutor | Four study modes, scope selection, grounded response and timestamp citations |
| Study paths | De-duplicated topic roadmap with links to evidence |
| Flashcards | Source-linked active recall and SM-2 review scheduling |
| Practice labs | Curated, editable and graded Python, shell, Kubernetes exercises |

## Theme tokens

Design uses semantic CSS variables rather than hardcoded per-component theme values.

- Modes: `light`, `dark`, `system` (OS changes followed while in System).
- Accents: `indigo`, `teal`, `rose`.
- Persistence: `localStorage` key `courseforge-theme-v3` (on-device).
- Background layers: `--bg`, `--surface`, `--surface-2`, `--surface-3`.
- Text: `--ink`, `--ink-soft`, `--muted`.
- Emphasis: `--accent`, `--accent-text`, `--accent-subtle`, `--accent-hover`.
- Interaction: visible keyboard focus indicators and reduced-motion styles.

No external JavaScript or font CDN is needed. Course thumbnails are generated with CSS gradients, avoiding missing external images and network requests.

## Responsive behavior

- Desktop: persistent sidebar, top search, multi-column course cards and two-column learning room.
- Tablet: collapsible navigation, reduced metric/card columns, compact tutor.
- Mobile: drawer navigation, single-column courses, stacked player and curriculum; theme settings stay accessible.

## Data and functional boundaries

All screens call existing `/api/*` endpoints. The UI does not synthesize AI answers or fabricate progress when the library is empty. The status area displays ingestion errors/queued jobs. Data persistence remains SQLite and the local media directories. The frontend does not execute AI-generated code; curated lab submissions are evaluated by the existing locked-down grader.

**Known limitations:** Course covers are intentionally illustrative instead of remote marketing thumbnails. File format compatibility depends on native browser codecs (MKV may need conversion). The sample screenshots used during QA were generated with simulated API payloads and are not real user course data. UI/browser integration checks are separate from live Ollama/Whisper/Qdrant/Docker runtime validation.