// INFRA T4 follow-up: the sqld JWT pair for branch CI and tests. Node builtins only.
// sqld (libsql-server) verifies database tokens against ONE Ed25519 public key given as SQLD_AUTH_JWT_KEY: the raw
// 32 key bytes in URL-safe base64 without padding. A token is a JWT signed with the matching private key (alg EdDSA).
// Nothing here is stored: CI makes a fresh pair per run and keeps it in a temp folder; the private key never enters
// an image, an env file of the stack or a log.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** @returns {{ publicKey: string, privateKeyPem: string }} publicKey = SQLD_AUTH_JWT_KEY value */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    publicKey: String(jwk.x), // base64url, no padding: exactly what sqld wants
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * @param {string} privateKeyPem
 * @param {{ access?: "ro" | "rw", ttlSec?: number, nowSec?: number, ns?: string }} [o]
 */
export function mintToken(privateKeyPem, o = {}) {
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT" };
  const claims = { a: o.access ?? "rw", exp: now + (o.ttlSec ?? 6 * 3600), iat: now };
  if (o.ns) claims.id = o.ns;
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = sign(null, Buffer.from(input), createPrivateKey(privateKeyPem));
  return `${input}.${b64u(sig)}`;
}

/** Local check (tests only): does the token verify against the SQLD_AUTH_JWT_KEY value? */
export function verifyToken(token, publicKey) {
  const [h, c, s] = String(token).split(".");
  if (!h || !c || !s) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  return verify(null, Buffer.from(`${h}.${c}`), key, Buffer.from(s, "base64url"));
}

// CLI for branch CI (output is a throwaway test credential, never anything real):
//   node jwt.mjs gen <dir> <name>...   write <dir>/<name>.pem (private, mode 600) and <dir>/<name>.pub for each name
//   node jwt.mjs mint <pem-file> [ttl-seconds]   print a token signed with that key (negative ttl = already expired)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function cli(argv, out = (s) => console.log(s)) {
  const [cmd, a, ...rest] = argv;
  if (cmd === "gen" && a && rest.length > 0 && rest.every((n) => /^[a-z0-9-]+$/.test(n))) {
    mkdirSync(a, { recursive: true, mode: 0o700 });
    for (const n of rest) {
      const k = generateKeyPair();
      writeFileSync(path.join(a, `${n}.pem`), k.privateKeyPem, { mode: 0o600 });
      writeFileSync(path.join(a, `${n}.pub`), `${k.publicKey}\n`, { mode: 0o600 });
    }
    out(`jwt: wrote ${rest.length} key pair(s)`);
    return 0;
  }
  if (cmd === "mint" && a) {
    const ttl = rest[0] === undefined ? undefined : Number(rest[0]);
    out(mintToken(readFileSync(a, "utf8"), ttl === undefined ? {} : { ttlSec: ttl }));
    return 0;
  }
  out("usage: jwt.mjs gen <dir> <name>... | mint <pem-file> [ttl-seconds]");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = cli(process.argv.slice(2));
}
