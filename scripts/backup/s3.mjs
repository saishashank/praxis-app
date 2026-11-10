// INFRA T5 (REQ\infra\INFRA_REQUIREMENT.md §8.2, §15.1): a minimal S3-compatible client for the
// off-box backup bucket (Backblaze B2 or Cloudflare R2). AWS Signature Version 4 with Node's
// built-in crypto and fetch only: no SDK, no new dependency. Path-style addressing
// (`<endpoint>/<bucket>/<key>`), which both B2 and R2 accept.
//
// Errors carry the step and the HTTP status only: never a URL, a key, a header or a response body.
import { createHash, createHmac } from "node:crypto";

const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const MAX_LIST_PAGES = 50;

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
export const EMPTY_SHA256 = sha256Hex("");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding as SigV4 wants it (everything but A-Z a-z 0-9 - . _ ~). */
export const uriEncode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20150830T123600Z` from a Date. */
export const amzDateOf = (d) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * Sign one request (SigV4, header form).
 * @param {{
 *   method: string, url: string, headers?: Record<string, string>, payloadHash?: string,
 *   accessKeyId: string, secretAccessKey: string, region: string, service: string, date: Date,
 *   s3?: boolean, contentSha?: boolean,
 * }} o  s3 = single URI encoding and the x-amz-content-sha256 header (default true for service "s3")
 * @returns {{ headers: Record<string, string>, canonicalRequest: string, stringToSign: string,
 *   signature: string, signedHeaders: string, authorization: string }}
 */
export function signRequest(o) {
  const s3 = o.s3 ?? o.service === "s3";
  const contentSha = o.contentSha ?? s3;
  const u = new URL(o.url);
  const amzDate = amzDateOf(o.date);
  const day = amzDate.slice(0, 8);
  const payloadHash = o.payloadHash ?? EMPTY_SHA256;

  const headers = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = String(v);
  headers.host = u.host;
  headers["x-amz-date"] = amzDate;
  if (contentSha) headers["x-amz-content-sha256"] = payloadHash;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const path = u.pathname
    .split("/")
    .map((seg) => (s3 ? uriEncode(decodeURIComponent(seg)) : uriEncode(uriEncode(seg))))
    .join("/");
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    o.method.toUpperCase(),
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${o.secretAccessKey}`, day);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, o.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    headers: { ...headers, authorization },
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    authorization,
  };
}

export class S3Error extends Error {
  /** @param {string} step @param {number | null} status */
  constructor(step, status) {
    super(`bucket ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.step = step;
    this.status = status;
  }
}

/** Region from a Backblaze endpoint (`s3.us-west-004.backblazeb2.com`); R2 and others use "auto". */
export function regionFromEndpoint(endpoint) {
  const m = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(new URL(endpoint).hostname);
  return m ? m[1] : "auto";
}

const xmlText = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * @param {{ endpoint: string, bucket: string, keyId: string, secret: string, region?: string,
 *   fetchImpl?: typeof fetch, now?: () => Date }} cfg
 */
export function createS3({ endpoint, bucket, keyId, secret, region, fetchImpl = fetch, now }) {
  let base;
  try {
    base = new URL(String(endpoint).trim());
  } catch {
    throw new Error("bucket client misconfigured");
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && local)) ||
    !/^[A-Za-z0-9._-]{3,63}$/.test(String(bucket)) ||
    typeof keyId !== "string" ||
    keyId === "" ||
    typeof secret !== "string" ||
    secret === ""
  ) {
    throw new Error("bucket client misconfigured");
  }
  const origin = `${base.protocol}//${base.host}`;
  const rgn = region && region.trim() !== "" ? region.trim() : regionFromEndpoint(origin);
  const clock = now ?? (() => new Date());

  const objectUrl = (key, query = []) => {
    const path = `/${bucket}/${key.split("/").map(uriEncode).join("/")}`;
    const q = query.length
      ? `?${query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&")}`
      : "";
    return `${origin}${key === "" ? `/${bucket}` : path}${q}`;
  };

  async function call(step, method, url, body, timeoutMs = TIMEOUT_MS) {
    const payload = body ?? new Uint8Array(0);
    const signed = signRequest({
      method,
      url,
      payloadHash: body ? sha256Hex(payload) : EMPTY_SHA256,
      accessKeyId: keyId,
      secretAccessKey: secret,
      region: rgn,
      service: "s3",
      date: clock(),
    });
    const { host: _host, ...headers } = signed.headers; // fetch sets Host itself
    try {
      return await fetchImpl(url, {
        method,
        headers,
        ...(body ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new S3Error(step, null);
    }
  }

  return {
    /** @param {string} key @param {Uint8Array} bytes */
    async put(key, bytes) {
      const res = await call("put", "PUT", objectUrl(key), bytes, UPLOAD_TIMEOUT_MS);
      if (res.status !== 200 && res.status !== 201) throw new S3Error("put", res.status);
    },

    /** @returns {Promise<Uint8Array | null>} null when the object does not exist */
    async get(key) {
      const res = await call("get", "GET", objectUrl(key), undefined, UPLOAD_TIMEOUT_MS);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new S3Error("get", res.status);
      return new Uint8Array(await res.arrayBuffer());
    },

    /** 404 is fine (already gone). */
    async delete(key) {
      const res = await call("delete", "DELETE", objectUrl(key));
      if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
        throw new S3Error("delete", res.status);
      }
    },

    /** All objects under a prefix (ListObjectsV2, paged). @returns {Promise<{ key: string, size: number, lastModified: string }[]>} */
    async list(prefix) {
      const out = [];
      let token = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query = [
          ["list-type", "2"],
          ["prefix", prefix],
        ];
        if (token) query.push(["continuation-token", token]);
        const res = await call("list", "GET", objectUrl("", query));
        if (res.status !== 200) throw new S3Error("list", res.status);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
          const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
          const lm = /<LastModified>([^<]+)<\/LastModified>/.exec(m[1]);
          if (!key) throw new S3Error("list", null);
          out.push({
            key: xmlText(key[1]),
            size: size ? Number(size[1]) : 0,
            lastModified: lm ? lm[1] : "",
          });
        }
        const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) return out;
        token = xmlText(next[1]);
      }
      throw new S3Error("list", null);
    },
  };
}
