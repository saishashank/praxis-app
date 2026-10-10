// Content-Security-Policy with a per-request nonce (SEC-012). No 'unsafe-inline' for scripts.
// style-src keeps 'unsafe-inline' because next/font and Tailwind emit inline style attributes.
export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp(nonce: string, dev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "object-src 'none'",
  ];
  if (!dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
