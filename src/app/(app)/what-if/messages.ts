// Result codes of the What-if action and the plain text shown for each (UX-119). No internals.
import type { WhatIfView } from "@/lib/whatif/options";

export type WhatIfBudgetView = { limit: number; used: number; remaining: number };
export type WhatIfActionResult =
  { ok: true; view: WhatIfView; budget: WhatIfBudgetView } | { error: string };

export const WHATIF_ERROR_TEXT: Record<string, string> = {
  invalid: "Please check the choices and try again.",
  forbidden: "Only the Owner and Editors can run what-ifs.",
  not_available:
    "Not available in this version. What-ifs only answer from the results the system works out each night.",
  not_found: "That strategy is not running. Reload the page.",
  no_data:
    "There is no nightly result for that yet. It appears after the next nightly run, and this did not use up one of today's what-ifs.",
  limit_reached:
    "You have used all of today's what-ifs. The count starts again at midnight in Melbourne.",
  unavailable: "Something went wrong and nothing was changed. Please try again.",
};

export const whatIfErrorText = (code: string): string =>
  WHATIF_ERROR_TEXT[code] ?? WHATIF_ERROR_TEXT.unavailable!;
