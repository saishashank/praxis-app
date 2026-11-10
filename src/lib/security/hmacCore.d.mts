export const HMAC_SCHEME_VERSION: 2;
export const HEADER_TIMESTAMP: "x-praxis-timestamp";
export const HEADER_NONCE: "x-praxis-nonce";
export const HEADER_SIGNATURE: "x-praxis-signature";
export const HEADER_VERSION: "x-praxis-version";
export function hmacMessage(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256Hex: string;
}): string;
export function signedHeaders(
  timestamp: string,
  nonce: string,
  signatureHex: string,
): Record<string, string>;
