export const FORMAT: string;
export const OUT_FILE: string;
export function codesOfFile(text: string): string[];
export function callClaimsOf(json: unknown): { id: string; statement: string }[];
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: {
    out?: (s: string) => void;
    now?: () => Date;
    allowInsideRepo?: boolean;
  },
): Promise<number>;
