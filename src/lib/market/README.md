# src/lib/market: the market profile (M19)

The only place a market fact is written down (MKT-107, DAT-241). Everything else asks the loader.

| File                                                | What it is                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fields.mjs`                                        | `PROFILE_FIELDS` (40 names), `validateField`, `COUNTED_TRIAL_FIELDS`, `MKT_KEY_FIELDS` (the nine `mkt.<CODE>.<field>` keys and who may edit them)                                                                                                                                                                                                                      |
| `profileCore.mjs` (+ `.d.mts`)                      | Pure core, importable by the Worker and the Actions scripts: `OWNER_TZ`, `GLOBAL_INDICES`, `HOME_MARKET`, `OPS_SLOT_TIMES`, `CURRENCY_FORMATS`, `currencyFormatOf`, `marketsEnabledDefault`, `encodeValue`/`decodeValue`, `profileFromRows`, `completeness`/`isComplete`, `slotsProjection`/`slotsJson`, `addMinutes`, `valueFromKey`/`overlayKeyValue`                |
| `profile.ts`                                        | The typed loader: `loadProfile`, `loadProfiles`, `enabledMarkets`, `isMarketEnabled`, `requireEnabledMarket`, `profileOf`, `invalidateProfiles`, `mktKey`, `PROFILE_CACHE_MS`; re-exports `MarketProfile`, `MarketNotEnabled`, `UnknownMarket`, `OWNER_TZ`, `GLOBAL_INDICES`, `builtMarkets`                                                                           |
| `profileWrite.ts`                                   | The one writer: `setProfileField`, `markFieldVerified` (field row, change ledger, version, `market` projection, counted trial, cache)                                                                                                                                                                                                                                  |
| `resolve.ts`                                        | `resolveMarket(db, candidate, user)` and `resolveMarketOrNotFound` (the one place a market parameter is accepted, D-997)                                                                                                                                                                                                                                               |
| `errors.mjs`                                        | `MarketNotEnabled`, `isMarketNotEnabled`, `UnknownMarket` (A2's `guard.mjs` re-exports `MarketNotEnabled`, it does not redefine it)                                                                                                                                                                                                                                    |
| `guard.mjs` (+ `.d.mts`)                            | The write guard, app side (A2, D-995): `wrapClient(client, onRefusal)` maps migration 0035's `MarketNotEnabled <table>` refusal to the typed error, `assertMarketEnabled(db, code)` is the one-read pre-check every market-writing script runs before its first write; `mainDb()` is wrapped, scripts and the Worker call `wrapClient` from their own client factories |
| `seed/AU.mjs`, `IN.mjs`, `US.mjs`, `seed/index.mjs` | The single definition of every market fact (`SEEDS`, `builtMarkets()`, `seedOf(code)`); the migration and the fixtures are projections                                                                                                                                                                                                                                 |
| `seed/au/costProfiles.mjs`, `seed/au/tickTable.mjs` | The AU P0 to P6 cost tables, tick table, slippage buckets, half-spread floors and liquidity tiers, moved byte for byte (B2 rewires the engines to take them)                                                                                                                                                                                                           |
| `seed/allow.mjs`                                    | The AT-67 allow-list (`MARKET_LITERAL_ALLOW`), read by `scripts/ci/market-literals.mjs` (E1)                                                                                                                                                                                                                                                                           |

## The `MarketProfile` type (`profileCore.d.mts`)

`code`, `name`, `workStatus` (`not_started | in_build | testing | built | active | paused`), `statusChangedAt`, `builtAt`,
`evidenceRecordedAt`, `version`, `enabled` (boolean), `mode` (`off | data_only | full`), `fields` (every field as
`{ value, verify, verifiedAt, evidenceRef, overlay }`), and the typed accessors: `exchange`, `tz`, `sessionOpen`,
`sessionClose`, `currency`, `currencyFormat`, `decisionCutoff` (HH:MM) and `decisionCutoffZone`, `settlementDays`,
`parcelFloorMicro` (bigint, market currency), `advFloorPerParcelMicro` (parcel floor x 100), `openingAuctionWindow`,
`preopenRecheckMin`, `preopenAt` (open minus the re-check minutes, AU 09:55), `costFormula`, `classificationScheme`,
`haltModel`, `benchmarkIndex`, `benchmarkYahooSymbol`, `regimeIndex`, `volatilityIndex`, `indexCodes`
(`[benchmark, ...GLOBAL_INDICES]`), `yahooSuffix`, `dividendImputation`, `angleCount` (100 with imputation, else 99),
`universeMax` (null = no cap), `tickTable`, `tiers`, `slippage`, `batchSchedule`, `knownTimeRules`,
`barLatencyP95Min`, `slots` (the Worker's anchors), `completeness`, `complete`.

Money in a profile is micro units of the market currency (`1_000_000` per unit); a bigint inside a stored value is
written `"<n>n"` (`encodeValue`/`decodeValue`).

## How to read a market fact

```ts
const profile = await loadProfile(mainDb, market); // a code you already hold
const profile = await profileOf(mainDb, { market: env.market, defaultMarket: user.defaultMarket });
const market = await resolveMarketOrNotFound(mainDb, searchParams.market, user); // pages
const r = await resolveMarket(mainDb, formValue, user); // actions: { ok: false, error: "invalid" }
const enabled = await enabledMarkets(mainDb); // the switcher, e-mails, loops
```

A pure module takes a `MarketProfile` (or the one field) as an argument; the Worker and scripts import
`profileCore.mjs` and read the `market` row (`slots_json` is `slotsProjection(profile)` as JSON).

## Rules

- The seed modules are the only files (with `calendarRules.mjs` and `make-au-calendar.mjs`) that may hold a market literal (AT-67).
- A profile value is never written directly: `setProfileField` validates, ledgers, bumps the version, re-projects and invalidates.
- `complete` is computed, never stored (DAT-242); IN and US are incomplete in M19 by design.
- Adding a market is a seed module, a migration row (`node scripts/market/gen-seed-sql.mjs` for a first build), a fixture
  (`node scripts/market/gen-fixtures.mjs`) and a registry line in `seed/index.mjs`, together.
- M20: migration 0034 is applied and never regenerated. A later change to an IN or US seed value is projected into the
  generated regions of 0036 (`node scripts/market/gen-seed-sql.mjs --delta 0034`; `--check` verifies, and the plain
  `--check` verifies 0034 plus the delta against the seed). The guard triggers of 0036's tables are a generated region
  too (`node scripts/db/gen-market-guard.mjs`, `M20_TABLES`).
- M20: a market's batch-1 day is `src/lib/data/sources/<code lowercase>/day.mjs` exporting `prepareDay(db, o)` and
  `runDay(db, o)` (the shapes of `prepareBatch1` / `runBatch1`, `o.market` set); `batch1-core.mjs` finds it by
  convention for every built market but the home one, and throws `not built` while it is missing (D-1127).
- M20: every script opens its database with `scriptDb({ url, token })` (`src/lib/db/scriptClient.mjs`): the guard's
  error mapping and one S2 `market_not_enabled` incident per refused market-day.
- M20: the Worker decides a market-bound slot on `localFor(slot.tz, instant)`; `slot.tz` is set only for a zone that
  does not follow the home rule (IN, US), so the AU table is byte-identical. `FEED_SLOT_TIMES` is keyed by market and
  holds the home market only.
