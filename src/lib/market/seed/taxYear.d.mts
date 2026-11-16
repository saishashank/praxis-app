export const TAX_YEAR_START: Readonly<Record<string, string>>;
export function financialYearOf(market: string, d: string): number;
export function financialYearRange(market: string, fy: number): { start: string; end: string };
export function financialYearLabel(market: string, fy: number): string;
