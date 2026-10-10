// Open-redirect guard: only same-origin relative paths are accepted (UX-121).
export function safeCallbackUrl(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  // Control characters (tab/newline are stripped by URL parsers and can hide a "//").
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}
