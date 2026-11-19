export function readSession(dir: string): { bars: any[]; feeds: any };
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: { out?: (s: string) => void },
): Promise<number>;
