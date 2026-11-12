export const SOURCE: "in_yahoo_ns";
export function yahooNsSymbol(code: string, suffix: string): string;
export function fetchYahooNs(
  client: {
    fetch(
      url: string,
      init?: RequestInit & { source?: string; userAgent?: string },
    ): Promise<Response>;
  },
  code: string,
  suffix: string,
  o?: { range?: string },
): Promise<Response>;
