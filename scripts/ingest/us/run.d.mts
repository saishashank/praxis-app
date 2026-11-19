export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: {
    openDb?: (url: string, token: string | undefined) => any;
    nowMs?: () => number;
    out?: (s: string) => void;
    dayLoader?: (code: string) => Promise<any>;
  },
): Promise<number>;
