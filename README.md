# Praxis

Personal investment-research and **simulated** (paper) trading app for the ASX. Simulation for personal information only — not financial advice.

## Documents
- [`spec/`](spec/00_README_and_progress.md) — requirements (v2.4); start at `00_README_and_progress.md`.
- [Owner guide — M0 set-up](docs/owner-guide/M0_owner_guide.md) — step-by-step account and secrets set-up (BLD-010, BLD-012).
- [Glossary](docs/glossary.md) — one-line meanings of every term in the app and emails (BLD-012).
- [Decision log](docs/07_decision_log.md) · [Open questions](docs/06_open_questions.md) (BLD-003).
- [`docs/brand/`](docs/brand/BRAND.md) — logos, icons and brand rules.

Secrets are never stored in this repository. They live only in GitHub **environment** secrets, Vercel environment variables and Cloudflare Worker secrets (SEC-017, SEC-101).
