// INFRA T5: the SigV4 signer against AWS's published test vectors, and the bucket client with a
// fake fetch (no network, no credentials).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createS3,
  EMPTY_SHA256,
  regionFromEndpoint,
  S3Error,
  sha256Hex,
  signRequest,
} from "./s3.mjs";

// AWS documentation example credentials (public, not secrets).
const DOC_KEY_ID = "AKIDEXAMPLE";
const DOC_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

test("SigV4: the AWS test-suite vector get-vanilla signs to the published signature", () => {
  const r = signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    accessKeyId: DOC_KEY_ID,
    secretAccessKey: DOC_SECRET,
    region: "us-east-1",
    service: "service",
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(
    r.canonicalRequest,
    [
      "GET",
      "/",
      "",
      "host:example.amazonaws.com",
      "x-amz-date:20150830T123600Z",
      "",
      "host;x-amz-date",
      EMPTY_SHA256,
    ].join("\n"),
  );
  assert.equal(r.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(
    r.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("SigV4: the S3 documentation vector (GET Object with a Range header) matches", () => {
  const r = signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { Range: "bytes=0-9" },
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(r.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.equal(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("SigV4: query parameters are sorted and encoded", () => {
  const r = signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(r.canonicalRequest.split("\n")[2], "max-keys=2&prefix=J");
  // The S3 documentation's GET Bucket (List Objects) example signature.
  assert.equal(r.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

/** A tiny in-memory bucket behind a fake fetch; records what it saw. */
function fakeBucket(opts = {}) {
  const objects = new Map(); // key -> { bytes, lastModified }
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push({ method: init.method, url, headers: init.headers });
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    assert.equal(parts[0], "praxis-backups");
    const key = parts.slice(1).join("/");
    if (opts.fail) return { status: opts.fail, text: async () => "secret-body" };
    if (init.method === "PUT") {
      objects.set(key, {
        bytes: new Uint8Array(init.body),
        lastModified: "2026-01-02T03:04:05.000Z",
      });
      return { status: 200 };
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return { status: 204 };
    }
    if (key === "") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + 2); // tiny pages to exercise continuation
      const more = start + 2 < all.length;
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${
        more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""
      }${page
        .map(
          (k) =>
            `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>${objects.get(k).lastModified}</LastModified><Size>${objects.get(k).bytes.length}</Size></Contents>`,
        )
        .join("")}</ListBucketResult>`;
      return { status: 200, text: async () => xml };
    }
    const o = objects.get(key);
    if (!o) return { status: 404 };
    return { status: 200, arrayBuffer: async () => o.bytes.buffer.slice(0) };
  };
  return { objects, seen, fetchImpl };
}

const client = (fetchImpl) =>
  createS3({
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    bucket: "praxis-backups",
    keyId: "KEYID-SECRET",
    secret: "SECRET-VALUE",
    fetchImpl,
    now: () => new Date("2026-01-02T03:04:05Z"),
  });

test("put, get, list (paged) and delete round trip; requests are signed", async () => {
  const b = fakeBucket();
  const s3 = client(b.fetchImpl);
  const bytes = new Uint8Array([1, 2, 3, 250]);
  for (const k of ["a/1", "a/2", "a/3", "b/1"]) await s3.put(k, bytes);
  assert.deepEqual([...(await s3.get("a/2"))], [1, 2, 3, 250]);
  assert.equal(await s3.get("a/missing"), null);
  const listed = await s3.list("a/");
  assert.deepEqual(
    listed.map((o) => o.key),
    ["a/1", "a/2", "a/3"],
  );
  assert.equal(listed[0].size, 4);
  await s3.delete("a/1");
  await s3.delete("a/1"); // already gone: fine
  assert.deepEqual(
    (await s3.list("a/")).map((o) => o.key),
    ["a/2", "a/3"],
  );
  const put = b.seen[0];
  assert.match(
    put.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=KEYID-SECRET\/20260102\/us-west-004\/s3\/aws4_request, SignedHeaders=/,
  );
  assert.equal(put.headers["x-amz-content-sha256"], sha256Hex(bytes));
  assert.equal(put.headers.host, undefined);
});

test("errors carry the step and status only", async () => {
  const s3 = client(fakeBucket({ fail: 403 }).fetchImpl);
  await assert.rejects(s3.put("k", new Uint8Array(1)), (e) => {
    assert.ok(e instanceof S3Error);
    assert.equal(e.message, "bucket put failed (HTTP 403)");
    assert.equal(/secret|SECRET|KEYID|praxis-backups/.test(e.message), false);
    return true;
  });
  const down = client(async () => {
    throw new Error("ECONNRESET https://s3.example SECRET-VALUE");
  });
  await assert.rejects(
    down.list("x/"),
    (e) => e.message === "bucket list failed" && e.status === null,
  );
});

test("refuses a misconfigured client and a non-https endpoint", () => {
  const ok = { endpoint: "https://x.example", bucket: "bucket-1", keyId: "k", secret: "s" };
  assert.doesNotThrow(() => createS3(ok));
  assert.throws(() => createS3({ ...ok, endpoint: "http://x.example" }), /misconfigured/);
  assert.throws(() => createS3({ ...ok, endpoint: "not a url" }), /misconfigured/);
  assert.throws(() => createS3({ ...ok, bucket: "a/b" }), /misconfigured/);
  assert.throws(() => createS3({ ...ok, secret: "" }), /misconfigured/);
  assert.doesNotThrow(() => createS3({ ...ok, endpoint: "http://127.0.0.1:9000" }));
});

test("region comes from a Backblaze endpoint, otherwise auto", () => {
  assert.equal(regionFromEndpoint("https://s3.us-west-004.backblazeb2.com"), "us-west-004");
  assert.equal(regionFromEndpoint("https://abc.r2.cloudflarestorage.com"), "auto");
});
