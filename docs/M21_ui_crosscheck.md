# M21 UXN-319 cross-check (task U0)

Checker: Haiku (U0). Decision: D-1201 (2 accepted, 12 superseded, 21 rejected, 35 in total).

Amendment (task Z): this table is the checker's first reading. The ruling is the amended D-1201 in `docs/M21_design.md` (5 accepted, 7 superseded, 23 rejected); `scripts/ci/ui-crosscheck.test.mjs` checks the table against it and checks that each accepted item names a test that exists.

Sources read:
- Design verdicts: `docs/M21_design.md` section F (UXN-319 cross-check) and the D-1201 line.
- Item text: `praxis-app-data/Requirement/v1/spec/16_ui_next_level.md`, the 35 lines tagged `[PROPOSED]` (the full set; the grep of all P2/P3 lines shows no other unaccepted item).
- Superseding UXR ids: `Requirement/v2/spec/16_ui_redesign_delta.md` (via `wt-v3-req`).
- V3 spec: `Requirement/v3/spec/24_ui_ux_delta.md` (UXN-319 rule), `15_config_delta.md:31` (PLT-079, `pwa_push_enabled` false).
- Decisions: D-884 in `docs/M13L_design.md:792`.
- src paths are relative to `D:\Projects\Praxis\wt-m21-req`.

Method: each item's intent is one line from its spec text. The reason is checked against that text, then against the cited UXR id or src file:line where the design cites one. Every src file:line in this table was opened and read. No verdict was changed; a verdict that looks wrong is listed at the end for the design owner (D-1201 requires a decision line for any change).

Column "Holds?": yes = the design reason is consistent with the spec text; no = the spec text or the cited source contradicts the reason, or the cited item does not cover the intent; unclear = partly true, or needs data not checked here.

| ID | Spec intent (one line) | Design verdict and reason | Holds? | Superseding item / src file:line | Note |
|---|---|---|---|---|---|
| UXN-003 | Comfortable/Compact density, a personal preference that applies without reload | Rejected: duplicates the Text size preference and doubles the AT-82 matrix (cites UXR-009) | unclear | n/a | Text size exists (`src/lib/preferences/service.ts:39`, TEXT_SIZES normal/large), but density is row padding, not text size. UXR-009 (rows over boxes) does not address density, so the cited id does not support the reason. |
| UXN-008 | Skeleton placeholder shaped like the content on first load of nightly-table pages | Accepted: pure presentation; SectionLoading renders a shaped skeleton (C1) | yes | n/a | Today `SectionLoading` (`src/app/(app)/market/sections.tsx:31`) is a spinner/status line, so the item is still open. Matches the default rule. |
| UXN-010 | Non-blocking "Offline" badge from `navigator.onLine` | Accepted: client only; pairs with the PWA (P1) | yes | n/a | Consistent with PLT-078/PLT-079 (PWA, D-1231). |
| UXN-011 | Mobile fixed bottom tab bar; desktop left rail; same items and role visibility | Superseded by UXR-012 (phone first, bottom tab bar kept) | unclear | UXR-012 (phone part); `src/components/shell/TabBar.tsx:2` (top tab row from 1024 px, fixed bottom bar below; UXN-270) | Phone bar holds. The desktop left rail is replaced by a top tab row (UXN-270), which UXR-012 does not state. The superseding item should name UXN-270 as well. |
| UXN-014 | Opt-in standard Web Push for P0/P1 alerts, off by default | Rejected: web push is off; e-mail stays the alert channel (PLT-079, EML-004) | unclear | n/a | `Requirement/v3/spec/15_config_delta.md:31` sets `pwa_push_enabled` false, which confirms the default. EML-004 is the e-mail cap, not a channel rule. The stronger reason is the new data path (VAPID keys and subscription store), which the design does not give. |
| UXN-018 | One outline icon set; every meaningful icon paired with a text label or aria-label, colour from tokens | Superseded by UXR-055 (icons with labels) | no | UXR-055 (two-tone line icons on tabs and sections; empty-state illustrations) | UXR-055 does not require a text label on meaningful icons app-wide. Only the tab bar pairs icon and label (comment at `src/components/shell/TabBar.tsx:2` cites UXR-055). Item is partly open. |
| UXN-062 | Compact factual card comparing the best execution with matched-control outcomes | Rejected: needs a new data path | no | n/a | Spec text says it reuses the existing UX-014 control comparison (ARN-078). Presentation on existing data meets the default rule. Verify that the Dashboard does not already load this data. |
| UXN-105 | Tap-to-define glossary also works as a long-press on touch; keyboard reachable | Superseded: term popover already opens on tap (cites UXR-012) | no | n/a (UXR-012 does not cover the glossary) | Tap works: `Term` is a Radix popover trigger (`src/components/ui/Overlays.tsx:71`). The long-press requirement is not covered by tap or by UXR-012. Cited id does not support the verdict. |
| UXN-107 | Execution-bound Q&A panel on the existing LLM fallback chain (LLM-011), rules-only when budget is out | Rejected: needs a new LLM path or budget state | unclear | n/a | The spec says it uses the existing chain (LLM-011) and extends UXN-102. A new LLM route is needed, which is a cost decision; the design gives no LLM-021 or PRD-033 reference. |
| UXN-108 | Canned follow-up chips routed to cached answers | Rejected: needs a new LLM path (follows UXN-107) | unclear | n/a | Consistent only if UXN-107 is rejected. Chips that route to cached answers need no new path on their own. |
| UXN-109 | Clickable evidence citation popover: source type, timestamp, link, staleness note | Superseded by UXR-024 (reading order) and UXR-043 (sheets) | no | n/a (UXR-024 puts the evidence list last; UXR-043 is a sheet/drawer) | Neither UXR covers a citation popover or its staleness note (UX-007 2x rule). The cited ids do not support the verdict. |
| UXN-112 | Daily AI-explanation budget indicator (green/amber/red) with rules-only fallback labelled | Rejected: needs a new LLM path or budget state | unclear | n/a | Spec text says it reads the existing server-side budget state (LLM-021). If that state is already server-side, only the client exposure is new, which is not a new data path. Check before final. |
| UXN-116 | Provenance badge on rank scores that depend on an LLM input (AI or rules-only, LLM-050) | Rejected: needs a new LLM path or budget state | unclear | n/a | Spec reuses the UX-060 wording pattern. Whether the input provenance is stored per row is not verified here. |
| UXN-117 | Data-gap message stating the missing date range; Retry only, never "skip" | Superseded by UXR-007 (empty states direct) | no | n/a (UXR-007 covers empty states only) | UXR-007 says what will appear and when. It does not cover a data-gap error or the Retry-only rule. Verdict looks wrong. |
| UXN-124 | "What would change this view": thesis-breakers and rule conditions with distance from today's value | Superseded by UXR-024 (thesis-breakers with monitored value) | unclear | UXR-024 (thesis-breakers pills with monitored value) | Overlaps on thesis-breakers. Rule conditions and distance from today's value are not in UXR-024. Partly superseded. |
| UXN-125 | Plain-English narrative of at most 120 words by role R3, numeric grounding (LLM-034) | Rejected: needs a new LLM path or budget state | unclear | n/a | A new LLM role (R3) is needed. Whether R3 exists in the router is not checked here. |
| UXN-151 | Leverage-sleeve utilisation meter: usage vs configured size, lock and recovery state | Rejected: needs a new data path (group reason) | no | n/a | Spec says the sleeve usage, lock and recovery already appear under UX-011 and UX-032, so the data exists. The meter is presentation. Verdict looks wrong. |
| UXN-153 | Discrete scenario picker over pre-computed shock magnitudes | Rejected: needs a recompute beyond the nightly tables (UX-119) | no | n/a | Item text says the picker chooses among "a small number of pre-computed shock magnitudes already produced overnight", which UX-119 allows. Verified at `Requirement/v1/spec/16_ui_next_level.md:72`. Verdict looks wrong. |
| UXN-154 | Donut (up to 12 holdings) or treemap (more than 12) for the concentration view, same masking | Superseded by UXR-054 (Risk page concentration bars) | no | n/a (UXR-054 colours bars by category) | Concentration bars exist (`src/app/(app)/strategies/risk/page.tsx:328-340`). UXR-054 does not replace a donut or treemap. Verdict looks wrong. |
| UXN-155 | 30-day regime history strip and current regime duration (stored, computed) | Rejected: needs a new data path | unclear | n/a | Spec says it uses stored regime states (AGT-101). Whether regime states are stored per day is not verified here. |
| UXN-156 | Kill-switch state indicator (running/paused, timestamp, affected executions) and confirmation before pausing | Superseded by UXR-045 (state pills) and UXR-010 (confirmation) | unclear | UXR-045 (state pills as text); UXR-010 (destructive actions red only in the confirmation sheet) | Pills give state as text. The pause timestamp and affected executions are not in UXR-045. UXR-010 does not require confirmation before pausing. Partly superseded. |
| UXN-162 | Expandable reverse-chronological event log for Risk Monitor, same masking | Rejected: needs a new data path (group reason) | no | n/a | Spec reuses the existing "latest events" (UX-050) with the existing masking (UX-009). No new data. Verdict looks wrong. |
| UXN-164 | Categorical source-type tag (exchange/regulator, news wire, other) from the source register | Rejected: needs a new data path (group reason) | no | n/a | Spec draws the tag from the existing source register (DAT-120). Verdict looks wrong unless DAT-120 lacks the type field (not checked here). |
| UXN-165 | Small price sparkline on news cards that touch a held code; omitted for masked users | Rejected: needs a new data path (group reason) | unclear | n/a | Needs recent prices for held codes on the news page. Whether the page loads them is not verified here. |
| UXN-169 | Dark-mode-safe e-mail CSS (color-scheme, prefers-color-scheme block) | Rejected: conflicts with D-884 (navy on white) | unclear | n/a | D-884 (`docs/M13L_design.md:792`) records the Owner's wish for white with navy. The block applies only in dark-mode clients and does not change the default light e-mail, so the conflict is not shown. |
| UXN-202 | Heatmap of lesson or family performance by regime or tag, development split only, labelled descriptive | Rejected: needs a new data path (group reason) | unclear | n/a | The per-regime, per-lesson aggregation is new work and the development split (ARN-071) is named. The data is not verified here. |
| UXN-204 | Before/after parameter diff and metrics snapshot in the existing version history | Rejected: needs a new data path (group reason) | unclear | n/a | The diff uses the KB-010 schema; a metrics snapshot per version may not be stored. Not verified here. |
| UXN-205 | Regime filter and per-row read/unread dot on the Evening Review archive, beside "Mark as read" | Superseded by UXR-026 ("the read state is already shown") | no | `src/app/(app)/reviews/page.tsx:227` (shows "Read" / "Not read yet" as text) | Read state is shown as text, so that part holds. The regime filter is not covered by UXR-026 or the read state. Verdict looks wrong for the regime filter. |
| UXN-207 | 30-day per-job status strip on System Health, stored status only, no invented uptime % | Rejected: needs a new data path (group reason) | unclear | n/a | The spec says stored per-day status (NFR-006). Whether a daily status history exists is not verified here. |
| UXN-209 | Usage meter tiles with a sparkline of recent usage and a plain projection | Rejected: needs a new data path (group reason) | unclear | n/a | Needs recent usage history per meter. Not verified here. |
| UXN-211 | Owner-only regime thresholds section with a live "today's regime" preview from stored data | Rejected: needs a new data path (group reason) | unclear | n/a | The spec says the preview is computed from stored data, so the data is not new; only the computation is. Partly consistent. |
| UXN-215 | Grade filter (L0 to L3) in the search, with an info icon opening the Glossary entry | Superseded: the grade filter already exists on "What we learned" | yes | `src/app/(app)/reviews/learned/page.tsx:125-128` ("Evidence grade" select, L0 to L3 from `GRADE_CHOICES`, line 41) | Filter exists. The info-icon part is not checked. |
| UXN-250 | Dashboard tile layout and tint change with the market regime; SHOCK pins P0 alerts to the top | Superseded by UXR-053 (Home mood gradient) | no | UXR-053 (Home status strip background gradient by mood) | UXR-053 covers only a background tint on Home. Tile reordering and pinning P0 alerts are not covered. Partly superseded. |
| UXN-252 | Hover/tap popover on any score or badge showing its deterministic rule-based sub-scores | Superseded by UXR-024 (rules-fired table on the Decision Card) | no | n/a | UXR-024 is one table on the Decision Card. UXN-252 covers badges across the app (thesis-breaker, validation, lesson grade). Verdict looks wrong. |
| UXN-255 | Optional collapsible category menu for the Arena tile grid; full grid stays unfiltered by default | Rejected: conflicts with UXR-023's single 12-tile grid | no | n/a | The spec keeps the full 12-tile grid by default and calls the menu a navigation aid that hides nothing, so the conflict is not shown. Verdict looks wrong, or the reason needs restating. |

## Completeness

- The 35 [PROPOSED] ids in v1 ch. 16 match the design's list exactly (2 + 12 + 21).
- No P2 or P3 line in v1 ch. 16 is untagged, so no unlisted item was found.

## Verdicts that look wrong

For the design owner to review. No verdict was changed in this file.

- UXN-018 (superseded): UXR-055 does not require labels on meaningful icons app-wide. Looks partly open.
- UXN-062 (rejected): spec reuses the existing UX-014 comparison. Looks like presentation on existing data.
- UXN-105 (superseded): tap works but the long-press requirement is not covered; cited UXR-012 is unrelated.
- UXN-109 (superseded): neither UXR-024 nor UXR-043 covers a citation popover.
- UXN-117 (superseded): UXR-007 covers empty states, not data-gap errors.
- UXN-151 (rejected): the sleeve data is already required (UX-011, UX-032); the meter is presentation.
- UXN-153 (rejected): the item itself says the picker uses pre-computed shocks, which UX-119 allows.
- UXN-154 (superseded): UXR-054 does not replace a donut or treemap.
- UXN-162 (rejected): reuses the existing latest-events data (UX-050).
- UXN-164 (rejected): source type comes from the existing register (DAT-120).
- UXN-205 (superseded): the read state is shown, but the regime filter is not covered.
- UXN-250 (superseded): UXR-053 covers only the tint; reordering and P0 pinning are not covered.
- UXN-252 (superseded): UXR-024 covers one table on the Decision Card, not app-wide popovers.
- UXN-255 (rejected): the full grid stays by default, so the stated conflict with UXR-023 is not shown.
