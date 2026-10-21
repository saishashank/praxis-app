export type Kind = "heading" | "label" | "button" | "summary";
export type Item = { kind: Kind; text: string };
export type PageItems = { path: string; items: Item[] };
export type Exception = { page?: string; text: string; reason?: string };
export type Failure = { page: string; kind: string; text?: string; grade: number };
export type Result = {
  failures: Failure[];
  applied: string[];
  summary: { page: string; kind: string; count: number; grade: number }[];
};
export const MAX_GRADE: number;
export function analyse(
  pages: PageItems[],
  options?: { terms?: string[]; exceptions?: Exception[]; maxGrade?: number },
): Result;
export function report(result: Result): string;
