export type Robots = "allows" | "disallows" | "absent" | "unreachable";
export type Summarisation = "yes" | "no" | "unknown";
export type LicenceStatus = "unchecked" | "enabled" | "owner-accepted-risk" | "no";
export type LicenceSource = {
  key: string;
  kind: "platform" | "site";
  manual: boolean;
  origin: string | null;
  path: string;
  termsPaths: string[];
};
export type SourceFetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: "manual" },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;
export type SourceCheck = {
  robots: Robots;
  summarisation: Summarisation;
  termsUrl: string | null;
  requests: number;
};
export const LICENCE_AGENT: string;
export const MANUAL_ONLY_PLATFORMS: readonly string[];
export const PLATFORM_SITES: Readonly<
  Record<string, { origin: string; path: string; termsPaths: string[] }>
>;
export const TERMS_PATHS: readonly string[];
export const LIMITS: Readonly<{
  keyChars: number;
  maxRedirects: number;
  maxTermsChars: number;
  maxSourcesPerExpert: number;
  spacingMs: number;
  maxRunRequests: number;
}>;
export function sourcesOf(expert: {
  platforms?: string[];
  handles?: Record<string, string>;
  homeUrls?: string[];
}): LicenceSource[];
export function readTerms(text: string): Summarisation;
export function decideStatus(i: {
  robots: Robots;
  summarisation: Summarisation;
  previous: LicenceStatus | null;
}): LicenceStatus;
export function checkSource(
  source: LicenceSource,
  deps: {
    fetch: SourceFetch;
    agent?: string;
    sleep?: (ms: number) => Promise<void>;
    maxRequests?: number;
  },
): Promise<SourceCheck>;
export type LicenceReport = {
  sources: number;
  checked: number;
  enabled: number;
  acceptedRisk: number;
  no: number;
  unreachable: number;
  notFetched: number;
  capped: number;
  requests: number;
};
export type CheckedRow = {
  expertId: string;
  sourceKey: string;
  checkedAt: string;
  termsUrl: string | null;
  robots: Robots;
  summarisation: Summarisation;
  status: LicenceStatus;
  note: string | null;
};
export function checkExperts(i: {
  experts: {
    id: string;
    platforms?: string[];
    handles?: Record<string, string>;
    homeUrls?: string[];
    noFeed?: boolean;
  }[];
  previous?: (expertId: string, key: string) => LicenceStatus | null;
  fetch: SourceFetch;
  sleep?: (ms: number) => Promise<void>;
  agent?: string;
  now?: () => Date;
  maxRequests?: number;
}): Promise<{ rows: CheckedRow[]; report: LicenceReport }>;
