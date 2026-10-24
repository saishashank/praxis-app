# The secrets tool: set a value everywhere with one command

One command sets a secret or setting in every place that holds it: GitHub environments, the Vercel
projects and the Cloudflare Workers. You never open a dashboard to paste the same value three times.
It runs on your computer under **your own** logins; the build agent never runs it and never sees a value.

## Once: sign in and check

```bash
npm run secrets -- login
```

```bash
npm run secrets -- doctor
```

`login` opens the browser for Cloudflare and Vercel; `gh` uses your normal GitHub login (an account
with admin on `praxis-app`). `doctor` must say `ok` three times.

The tool also needs the Vercel team and project ids. They sit in `praxis-secrets-targets.json`
**next to** the repo folder (`D:\Projects\Praxis\praxis-secrets-targets.json`), never inside it:

```json
{
  "vercel": { "teamId": "team_...", "projects": { "production": "prj_...", "staging": "prj_..." } },
  "cloudflareAccounts": { "production": "<account id>" }
}
```

## See what is held where

```bash
npm run secrets -- list --check
```

Every value with each place it goes; `--check` reads the stores (names only) and marks ✓ present,
✗ missing, ? could not read. Add `--env staging` or `--env all` for the other environments.

## Set a value

```bash
npm run secrets -- set worker
```

1. The tool prints the plan: each value and every place it will be written. Nothing is written yet.
2. Type `yes`.
3. For each value, either the tool makes it (the random 64-hex signing and encryption keys) or it asks
   you to type or paste it at a hidden prompt. It checks the shape (a GitHub token, a `libsql://`
   address, a Resend key ...) and asks again if it looks wrong.
4. It writes each place and prints `ok` or `FAILED` per place. A value is never printed.

What you can name after `set`:

| You type | Means |
|---|---|
| `worker` | Everything the production Worker needs: dispatch token, Worker signing secret (Worker and Vercel), Turso address and token |
| a row letter: `b`, `c2`, `d`, `j` ... | That row of the rotation table in `M8_go_live.md`, in every store |
| a stored name: `RESEND_API_KEY`, `TURSO_MAIN_TOKEN` ... | Just that name, in every store |
| `turso-main-url`, `app-base-url`, `owner-email` ... | The settings that are not secret but live in the same stores |

Options: `--env staging|all` (default production), `--only github,vercel,worker`, `--paste` (type
your own value for a key the tool would make), `--dry-run` (plan only), `--yes` (no question),
`--redeploy` (start the deploy workflow afterwards; production still waits for your approval in
GitHub Actions). Worker secrets take effect at once; Vercel reads values when it deploys.

If a place fails, fix the cause (usually a login: run `doctor`) and run the same command again. Values
the tool made are new each run, so it simply writes a fresh one everywhere.
