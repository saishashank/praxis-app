# Chapter 08 — Knowledge Base, Playbooks and Controlled Change  (v2.0, session 10)

_Replaces the imported drafts `08_knowledge_base.md` v0.1 and `08_playbooks_v1_concrete.md` v1.0. The live rule set for the six families is Ch. 07 §7.4; the imported "concrete playbooks" (Value+EPS, Dividend, Sector rotation, Growth+upgrade …) survive only as Lane-B hypotheses (FAM-101) and their unmeasured statistics are void (REV-003). Requirements only — no code._

## 8.1 Purpose
The knowledge base (KB) is the system's memory: every rule version, lesson, review, hypothesis and decision is stored as data **and** as readable markdown, so the Owner, the agents and future build sessions can always see what the system believes, why, and since when (PRD-009).

## 8.2 Structure
- **KB-001 Two synchronised forms.** (a) Structured records in the database (playbook_version, lesson, challenger, change_ledger, decision_card, document); (b) markdown documents generated from them and archived nightly to the **separate private data repository** under `knowledge/` (PLT-022a) — never to the code repository, so archives never trigger deployments. The database is authoritative; markdown is regenerated, never hand-edited by agents.
- **KB-002 Layout** (per market):

| Path | Content | Written by |
|---|---|---|
| `knowledge/{market}/families/F1…F6.md` | Current rule version, parameters with bounds, validation label, version history | A5/A6 on change |
| `knowledge/{market}/agent-playbooks/{agent}.md` | ≤ 1,500-token distilled guidance injected into that agent's LLM prompt (ARN-064) | A6 (Lane A) |
| `knowledge/{market}/lessons/L-{id}.md` | One lesson: statement, metrics, n, grade, evidence links, Critic answers | A6/A7 |
| `knowledge/{market}/challengers/C-{id}.md` | Hypothesis document, replay results, forward shadow results, Critic answers, decision | A6/A7 |
| `knowledge/{market}/reviews/YYYY-MM-DD.md` | The Evening Review content for that date (EML-015) | A8 |
| `knowledge/{market}/hypotheses/` | Untested ideas (L0), incl. those imported from session-8 playbooks | A6, Owner |
| `knowledge/common/` | Source-licence register export, incidents, decision log mirror | pipeline / ops |

- **KB-003** Every document carries front matter: id, market, type, created, updated, version, evidence grade (if any), related ids.

## 8.3 Rule representation
- **KB-010 (s11) Declarative rules.** A family rule version is a declarative specification: named conditions over the indicator/event vocabulary of AGT-020/AGT-030 (e.g. `volume_ratio >= p1`), exit rules, sizing rule, regime gate, universe tiers, and **parameters with configured lower/upper bounds**. The simulator interprets it; no code change is needed for a parameter change. Every rule MUST conform to a minimal declarative schema **(s11)**: conditions are records with {field, operator, value-or-param-ref}, combined by AND; condition groups MAY nest with `logic: AND | OR` and a `count_of(n, [conditions])` construct supports consensus rules (e.g. F6) **(s11)**; every family F1–F6 in §7.4 MUST be expressible in this schema; operators are from the fixed set {<, <=, >, >=, ==, crosses_above, crosses_below}; actions are tagged {enter | exit | size | gate}; all parameters reference bounds defined in Ch. 15; unknown fields or operators are rejected at load **(s11)**. **(s13)** The allowed `field` vocabulary is exactly the indicator/event fields of AGT-020 and AGT-030 plus the family parameters in ch. 15 §15.3; the build agent MUST publish it as an enumeration in the rule-schema reference at M3 and the loader MUST reject unknown fields. `count_of(n, [c…])` is true when at least n listed conditions are true; groups are explicit (no implied precedence) — mixing AND and OR at one level is invalid and rejected at load.
- **KB-011 Immutability.** A version is never edited after creation; changes create a new version with a parent pointer. Each execution records which version it runs; a version can be pinned for replay forever (ARN-102).
- **KB-012 v1 seed.** On first deployment, version 1 of F1–F6 per market is created from Ch. 07 §7.4 with grade L0 and label UNVALIDATED; its metric fields are empty until measured.

## 8.4 Evidence grades (single definition — ARN-063)
- **KB-020 (s9)** Evidence grades are defined **only** in ARN-063 (L0 Observation; L1 on the first two-thirds of development; L2 on the purged last third under cumulative α-investing; L3 adopted) — see ARN-063 for the exact rules. No lesson is described more strongly than its grade anywhere; any other grading text is void.

## 8.5 Lane A — knowledge changes (daily, low risk)
- **KB-030 (s9)** Lane A MAY change only what ARN-064 allows: agent-playbook (LLM prompt) text, Owner-facing notes, and alert-routing materiality adjustments that are never read by the Strategy Lab, filters or thesis-breakers (AGT-011a). Watch-lists are computed deterministically (AGT-014). Anything that can change a trade is Lane B.
- **KB-031** L0/L1 lessons may appear in agent playbooks only under a heading "Unproven notes"; L2+ may be stated as guidance. Lane-A application is automatic when no deterministic Critic check fails (AGT-042).
- **KB-032 (s9) Playbook hygiene (stored-injection defence).** Agent-playbook text is assembled from structured lesson fields (statement template, metric, n, grade), not free LLM prose; any LLM-worded sentence must pass the **injection classifier** — deterministic checks (imperative/instruction patterns, URLs, codes or numbers absent from the lesson record) plus a model check whose detection rate on the LLM-040 adversarial set is ≥ 98% — and must not contain imperative instructions, URLs, or codes absent from the lesson record. The classifier model is the one selected by the LLM-040 bake-off for the injection-detection role; its config key is named in Ch. 15 **(s11)**. Third-party text (announcements, news) is never copied into a playbook. Every Lane-A change writes a change-ledger row (before → after, lesson id, effective date = next session) and appears in Evening Review section 4. **(s13)** The model check uses the model chosen for the classifier role in the LLM-040 bake-off (`llm_classifier_model`); it MUST be a $0 endpoint (LLM-003).

## 8.6 Lane B — rule and parameter changes (guarded)
- **KB-040 (s9) Challenger lifecycle:** `proposed` (hypothesis document, generated only from the development split; counted as a trial when generated, ARN-085) → `replay` (ARN-080…083; exits when VAL-110 has been computed on the frozen validation split **(s11)** — if passed → `shakedown`, if failed → `rejected` **(s11)**) → `shakedown` (≥ 10 sessions on the live feed, unfunded — an operational check, **not evidence**) → `review` (deterministic Critic checks, AGT-041/042) → `approved` → `promoted` at the next cohort boundary of the target execution → or `rejected` / `retired`. Validation/holdout results are never shown to the agents that propose challengers. **(s13)** Failing any VAL-110 component sets the challenger to `rejected`; its trial-budget slot stays used and it is not re-tested (a new variant is a new trial).
- **KB-041 (s9) Promotion test** = **VAL-110** (Ch. 05 ARN-087) — the single definition. Any other rule ("beats Lane A by > 10%", "> 5% CAGR", "DSR only reported") is void.
- **KB-042 Limits:** ≤ 8 concurrent challengers per market (ARN-005); ≤ 3 promotions per week per market (ARN-065); parameters stay within bounds.
- **KB-043 Rollback.** Any promotion can be reverted from the change ledger; the reverted version becomes a new version (history is never rewritten). Kill switch ARN-093 freezes a family's changes.

## 8.7 Human edits
- **KB-050** Only the **Owner** may create or edit a family rule or parameter from the UI (ROL-102). An Owner edit creates a new version flagged `owner-authored`; by default it enters Lane B as a challenger. The Owner MAY force-apply it at the next cohort boundary, in which case the execution's validation label resets to UNVALIDATED and the action is audit-logged.
- **KB-051 (s9)** Editors may add annotations to lessons, cards and hypotheses (never altering the record). Viewers are read-only (ROL-102). Annotations and any user-entered free text are **never** included in LLM context (LLM-036).

## 8.8 Use by agents
- **KB-060** LLM prompts receive compact context packs built from the KB (LLM-037): the agent playbook, relevant lessons with grades, and the Decision Card — never whole histories.
- **KB-061** KB text is data, not instructions: any instruction-like text inside a KB document or third-party content is ignored and logged (LLM-035).

## 8.9 Search and access
- **KB-070** The Knowledge page (Ch. 09 §9.9) lists and full-text searches all KB documents by market, type, date, family, grade and code, with links to the underlying records.

## Acceptance criteria — Chapter 08
- **Given** first deployment, **then** F1–F6 version 1 exist per active market with grade L0, label UNVALIDATED and empty metric fields (KB-012).
- **Given** a Lane-A change, **then** a change-ledger row exists and no rule/parameter version changed (KB-030).
- **Given** a challenger with a higher win rate but failing any VAL-110 component, **then** it is not approved (KB-041).
- **Given** a lesson whose LLM wording contains "always buy XYZ" or a URL, **then** it is rejected from the playbook (KB-032).
- **Given** a promotion, **then** it takes effect only at the target execution's next cohort boundary and the old version remains replayable (KB-011, KB-040).
- **Given** an Editor opens a family rule, **then** no edit control is available and the API refuses writes (KB-050/051).
- **Given** a KB document containing "ignore previous instructions", **then** it has no effect on agent actions and an injection event is logged (KB-061).
- **Given** the nightly archive, **then** every record created that day has a regenerated markdown document in the repo (KB-001).
