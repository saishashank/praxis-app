// Licence policy words and rules (M22 E1; KB-083, D-1430). The rules themselves live in engine.mjs (shared with the
// build-machine script); this file is their typed face plus what the Owner reads. Pure: no database, no network.
import {
  decideStatus,
  LICENCE_AGENT,
  LIMITS,
  MANUAL_ONLY_PLATFORMS,
  readTerms,
  sourcesOf,
  type LicenceSource,
  type LicenceStatus,
  type Robots,
  type Summarisation,
} from "./engine.mjs";

export {
  decideStatus,
  LICENCE_AGENT,
  LIMITS,
  MANUAL_ONLY_PLATFORMS,
  readTerms,
  sourcesOf,
  type LicenceSource,
  type LicenceStatus,
  type Robots,
  type Summarisation,
};

export const LICENCE_STATUSES = ["unchecked", "enabled", "owner-accepted-risk", "no"] as const;
export const LICENCE_ACTORS = ["job", "owner", "import"] as const;
export type LicenceActor = (typeof LICENCE_ACTORS)[number];

/** The most requests one monthly run makes (every origin read once, shared origins are cached). */
export const MAX_RUN_REQUESTS = LIMITS.maxRunRequests;

/** D-939: only these two statuses allow a fetch of the source. */
export const isPollable = (status: LicenceStatus | null | undefined): boolean =>
  status === "enabled" || status === "owner-accepted-risk";

/** Titles and links only, never a summary, unless the terms clearly permit summarising (D-1430). */
export const titleAndLinkOnly = (summarisation: Summarisation): boolean => summarisation !== "yes";

export type LicenceFacts = {
  status: LicenceStatus;
  robots: Robots;
  summarisation: Summarisation;
};

/** One line for the expert page: the source's status in words (no internal codes). */
export function licenceWords(row: LicenceFacts | null, manual: boolean, fetchable = true): string {
  if (manual) return "Added by hand only. Nothing from this source is read automatically.";
  if (!fetchable) return "No known feed address, so nothing is read automatically.";
  if (row === null) return "Not checked yet. Nothing is read from it until it has been checked.";
  switch (row.status) {
    case "unchecked":
      return "Not checked yet: the site could not be reached. Nothing is read from it.";
    case "no":
      return row.robots === "disallows"
        ? "Not allowed: the site's robots file asks automated readers to stay away."
        : "Not allowed: its terms forbid automated reading or summarising.";
    case "owner-accepted-risk":
      return row.summarisation === "yes"
        ? "Allowed on your accepted risk. Short summaries are fine."
        : "Allowed on your accepted risk. Titles and links only.";
    default:
      return row.summarisation === "yes"
        ? "Allowed. Short summaries are fine."
        : "Allowed for titles and links only: the terms do not say whether summaries are fine.";
  }
}
