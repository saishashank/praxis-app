export const HEADER_TIMESTAMP: "x-praxis-timestamp";
export const HEADER_NONCE: "x-praxis-nonce";
export const HEADER_SIGNATURE: "x-praxis-signature";
export function hmacMessage(timestamp: string, nonce: string, rawBody: string): string;
export function signedHeaders(
  timestamp: string,
  nonce: string,
  signatureHex: string,
): Record<string, string>;
