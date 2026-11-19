export const ROOT: string;
export const OUT: string;
export function scanRoutes(root?: string): { patterns: string[]; exportRoutes: string[] };
export function render(root?: string): Promise<string>;
