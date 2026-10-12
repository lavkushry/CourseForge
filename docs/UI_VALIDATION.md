# CourseForge UI validation

All four stages are complete and deployed. **239 tests pass, all 36 browser release-gate checks pass, and all five authenticated clickthrough checks pass.** The final 415 captures have zero overflow, clipped controls, unequal grid cards, unmapped controls, invalid icon sizes or browser page errors.

The consistency pass resolves all 40 audit findings across 83 existing views and state variants. The layout, field sizes, button actions, card geometry and component states use the shared token and component contracts. All four stages were authorized together on 2026-10-11.

The [before/after gallery](ui-evidence/index.html) pairs every view at 320, 390, 768, 1366 and 1920 px. Original audit evidence and intermediate layout evidence remain available. The final application capture uses frozen revision `93aa9ad`; subsequent report changes do not alter those frontend files.

| Check | Evidence |
|---|---|
| Full capture matrix | 83 views × 5 widths; [manifest](ui-evidence/stage-3/manifest.json) |
| Geometry and component checks | [Complete measurements](ui-evidence/stage-3/measurements.json) and [validation](ui-evidence/stage-3/validation.json) |
| Authenticated learner and administrator flows | [Clickthrough report](ui-evidence/stage-4/clickthrough.json) |
| Unchanged protected implementations | [Nine file hashes](ui-evidence/stage-4/security-unchanged.json) |
| Production deployment | [Reviewed source hashes](ui-evidence/stage-3-deployment.json) and [public bundle verification](ui-evidence/public-assets.json) |
| Full suite and release gate | [Final verification report](ui-evidence/stage-4/validation.json) |

The UI release gate checks shipped sources and deterministic bundle parity. It rejects literal cosmetic colors and dimensions outside tokens, undefined CSS variables, static inline presentation, cosmetic JavaScript style assignments, and emoji icons. Dynamic artwork URLs and progress/chart geometry have explicit allowances. It requires Playwright, Chromium and WebKit, then checks populated layouts at all required widths, control mapping, icon dimensions and theme contrast. Missing browser dependencies fail the gate.

The shared browser collector checks child bounds even when page CSS hides overflow, control clipping, equal card heights and full grid-cell widths. A full-width empty grid state must fill the entire grid. Only the existing labelled carousel, code and table regions may scroll horizontally. Negative tests prove that hidden overflow, ad-hoc styling, emoji icons and missing evidence are rejected. Phone focus regression tests exercise Start/Pause with a pointer at the control edge; the obsolete hover movement previously caused a repeated hover/leave loop.

The authenticated clickthrough decodes and seeks a real lecture, checks the visible watermark, locks and unlocks controls, creates and removes notes and bookmarks, finishes a persisted focus session, creates an administrator invitation, activates and signs in the invited learner, opens the granted library, visits administrator tracking and checks persisted playback and learning events. Vault/session protections are also covered by the full suite. Authentication, media/vault delivery, ownership, recovery and event implementations match the production files byte for byte; player overlay and watermark behavior remain unchanged.

Verification uses a disposable anonymized SQLite backup of the real 11-course catalog. All administrator/learner QA records, invites and learning changes stay in that backup. The proof server uses local HTTPS for the existing invitation requirements; activation links and session credentials are never retained in evidence. Final full-page captures warm lazy images and virtualized lesson content so screenshots contain offscreen content. Original audit captures can contain unloaded offscreen regions.

The independent production media fixes (`e6b7bd0`, `7d491e7`) and artwork update (`883252f`) are preserved. Security hashes compare this pass against the current production implementation, while the original audit screenshots preserve the earlier visual baseline. The existing administrator tracking screen is a student-detail page; this pass audits that screen without adding a new modal.

Reproduce the source/browser gate and saved evidence checks with:

```bash
python scripts/release_gate.py --audit-tree --audit-icons --audit-ui --ui-evidence docs/ui-evidence/stage-3
pytest -q
```

Recreate final evidence against an authorized local course database with:

```bash
DATA_DIR=/path/to/courseforge/data python scripts/capture_ui_audit.py --strict --proof --output /tmp/courseforge-ui-capture --label 'Final UI verification'
```

The production URL is [CourseForge](https://acrobat-shopzilla-classified-webmasters.trycloudflare.com). The deployed [comparison gallery](https://acrobat-shopzilla-classified-webmasters.trycloudflare.com/static/ui-audit/ui-evidence/index.html) contains all 415 pairs and the final reports.
