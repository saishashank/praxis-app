// Class-name joiner (M7 T5, D-128: no tailwind-merge / cva). Falsy parts are dropped.
export function cn(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
