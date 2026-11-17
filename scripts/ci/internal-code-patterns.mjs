// The D-922 internal-code patterns (design M21 section J), in a module with no file-system or `import.meta` use, so the
// Playwright page walk (e2e/m21-at82.spec.ts, transpiled to CommonJS) can import them as well as the static scan
// (scripts/ci/internal-codes.mjs), which re-exports them (D-1331). The names are what a report prints.
export const PATTERNS = Object.freeze({
  strategyCode: /\bE\d{2}\b/,
  variantCode: /\bF\d-[UL]\b/,
  controlCode: /\bC\d-F\d\b/,
  specId: /\b(?:ARN|UXN|UXR|AGT|CTX|CXA|DAT|EML|FAM|VAL|PLT|MKT|SEC|LLM|KB|OPS|TST|BLD|PRD)-\d+/,
  decisionId: /\bD-\d{3,4}\b/,
  acceptanceId: /\bAT-\d+/,
  ownerDecisionId: /\bO-\d+/,
  priorityTag: /\bP[012]\b/,
  nav: /\bNAV\b/,
  cohortWord: /\bCS\b|\bIS\b/,
  statusTag: /\[(?:VERIFY|PROPOSED)\]/,
});

/** Names of the patterns that match `text`. */
export function matchPatterns(text) {
  return Object.entries(PATTERNS)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}
