export function csvObjects(text: string): Record<string, string>[];
export function isIsoDate(s: string): boolean;
export function microOfDecimal(s: string): bigint | null;
export function nseDateTime(s: string): { d: string; time: string } | null;
export function istToUtcIso(d: string, time: string): string;
