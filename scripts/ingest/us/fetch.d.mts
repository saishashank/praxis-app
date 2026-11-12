export function parseDailyIndex(
  text: string,
): { form: string; cik: string; filed: string; file: string }[];
export function fetchNight(o: {
  db: any;
  market: string;
  env: Record<string, string | undefined>;
  request: { codes: string[]; end: string };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  indexCsv?: Record<string, string>;
  out?: (s: string) => void;
}): Promise<{ feeds: any; outcome: Record<string, string> }>;
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: { out?: (s: string) => void; openDb?: () => any },
): Promise<number>;
