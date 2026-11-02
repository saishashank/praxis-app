// AT-45 fixture: the DAT-234 index-change upload, synthetic ZZ codes only (SEC-110). Kept as a string
// rather than a .csv file so the repo-hygiene data-file check stays strict.
export const INDEX_CHANGE_CSV = [
  "code,index,change,announced,effective,source",
  "ZZE,S&P/ASX 200,add,2026-10-06,2026-10-16,synthetic rebalance notice (AT-45 fixture)",
  "ZZF,S&P/ASX 200,delete,2026-06-01,2026-06-22,synthetic rebalance notice (AT-45 fixture)",
  "",
].join("\n");
