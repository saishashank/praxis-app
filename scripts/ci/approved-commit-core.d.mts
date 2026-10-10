export const SHA: RegExp;
export const API: string;
export class Fail extends Error {}
export function isValidRepo(repo: unknown): repo is string;
export function findApprovedSha(
  fetchImpl: (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{ status: number; json: () => Promise<unknown> }>,
  token: string,
  repo: string,
): Promise<string | null>;
