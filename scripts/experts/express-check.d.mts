export const TARGET_EXPRESSED: number;
export type ExpressSchema = {
  validateExpressedRule: (rule: unknown) => string[];
  validateExpressionExit: (exit: unknown) => string[];
};
export function checkExpressions(
  data: Record<string, any>,
  schema: ExpressSchema,
): {
  errors: string[];
  expressed: string[];
  parked: Record<string, string[]>;
  unaddressed: string[];
  total: number;
};
export function targetReport(
  r: { expressed: string[]; parked: Record<string, string[]>; unaddressed: string[] },
  target?: number,
): {
  target: number;
  expressed: number;
  met: boolean;
  shortfall: number;
  reasons: Record<string, number>;
  unaddressed: number;
};
export function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps?: { out?: (s: string) => void; schema?: ExpressSchema; allowInsideRepo?: boolean },
): Promise<number>;
