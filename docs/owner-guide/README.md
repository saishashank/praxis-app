# Owner guide

These guides are for you, the Owner. They are in plain English. Each step names the spec rule it comes from in square brackets. Where a screen name may have changed, the step says [VERIFY].

Never paste a secret into chat, email, a file, an issue or a log. [SEC-101]

## Which guide do I need?

| I want to | Read |
|---|---|
| Set up the free accounts and stores for the first time | [M0_owner_guide.md](M0_owner_guide.md) |
| Finish the bootstrap release, run the smoke test, use backups and break-glass recovery | [M1_owner_guide.md](M1_owner_guide.md) |
| Go live: merge, test on staging, revoke, rotate, drill, sign off, switch on | [M8_go_live.md](M8_go_live.md) |
| Run Praxis day to day, handle problems, roll back, restore | [operations.md](operations.md) |
| Rotate one secret in a hurry (suspected leak) | [M8_go_live.md](M8_go_live.md), section N |

## Order of use

1. M0: accounts, tokens, repositories, the bot. Done once.
2. M1: the first release and the first smoke test. Done once.
3. M8: the go-live sequence, phases P2 to P7. Done once.
4. Operations: daily, weekly, monthly, quarterly and yearly duties. Forever after.

## Other documents you may need

| Document | What it holds |
|---|---|
| [../glossary.md](../glossary.md) | Plain meanings of terms used in the app, the emails and these guides. |
| [../config-reference.md](../config-reference.md) | Every setting, its value and where it came from. |
| [../source-licence-register.md](../source-licence-register.md) | Every data source, its terms and whether it is switched on. |
| [../test-reports/](../test-reports/) | One report for each acceptance test, AT-01 to AT-31, with the Owner rows. |
| [../07_decision_log.md](../07_decision_log.md) | What was decided and when. |

## The three things to remember

1. **Rotation and revocation are yours.** The build agent never sees a production secret and never rotates or revokes anything. [BLD-040]
2. **Sign-off comes before trading.** Production stays in data-only mode until you record the sign-off on the go-live page and switch AU to `full`. [BLD-030]
3. **A rotation is done only when the smoke test passes.** For every secret you changed. [OPS-020]
