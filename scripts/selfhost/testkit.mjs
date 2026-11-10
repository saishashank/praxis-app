// Test helpers for scripts/selfhost/*.test.mjs and scripts/backup/bucket-copy.test.mjs: local libSQL
// files, an in-memory bucket and an in-memory data repo. No network, no credentials. Not a test
// itself (the test globs match *.test.mjs only).
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { seed } from "../backup/drill.mjs";

export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-selfhost-test-"));
  const clients = [];
  return {
    dir,
    /** A local libSQL file client (lossless integers, like the restore scripts). */
    open(name) {
      const c = createClient({ url: pathToFileURL(path.join(dir, name)).href, intMode: "bigint" });
      clients.push(c);
      return c;
    },
    url: (name) => pathToFileURL(path.join(dir, name)).href,
    cleanup() {
      for (const c of clients) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Windows may hold a lock briefly; the folder only held synthetic data.
      }
    },
  };
}

/** A synthetic migrated database (both real schemas) with the drill's fake rows. */
export async function seededDb(t, file, name) {
  const db = t.open(file);
  await seed(db, name);
  return db;
}

export async function setOwner(db, value) {
  if (value === null) {
    await db.execute("DELETE FROM worker_state WHERE key = 'clock_owner'");
    return;
  }
  await db.execute({
    sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('clock_owner', ?, '2026-01-02T00:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    args: [JSON.stringify(value)],
  });
}

export async function keyPair() {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** An in-memory object store with the same surface as createS3(). */
export function memoryS3() {
  const objects = new Map();
  const s3 = {
    objects,
    async put(key, bytes) {
      objects.set(key, { bytes: new Uint8Array(bytes), lastModified: s3.clock().toISOString() });
    },
    async get(key) {
      const o = objects.get(key);
      return o ? new Uint8Array(o.bytes) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, o]) => ({ key, size: o.bytes.length, lastModified: o.lastModified }));
    },
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
  };
  return s3;
}

/** An in-memory data repo with the surface of createGithub() that the new code uses. */
export function memoryGh() {
  const releases = new Map(); // tag -> { id, tag, assets: Map(name -> bytes), createdAt }
  let nextId = 1;
  const gh = {
    releases,
    addRelease(tag, createdAt, assets) {
      releases.set(tag, { id: nextId++, tag, createdAt, assets: new Map(Object.entries(assets)) });
    },
    async listReleases() {
      return [...releases.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((r) => ({
          id: r.id,
          tag: r.tag,
          assets: [...r.assets.keys()],
          createdAt: r.createdAt,
        }));
    },
    async downloadAsset(tag, name) {
      const b = releases.get(tag)?.assets.get(name);
      return b ? new Uint8Array(b) : null;
    },
  };
  return gh;
}

/**
 * A fake S3 endpoint at the fetch level (path-style, ListObjectsV2 with paging), so createS3() runs
 * for real: signing, URL building, XML parsing. Returns `{ fetchImpl, objects }`.
 */
export function fakeBucketFetch(bucket = "praxis-backups") {
  const objects = new Map();
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== bucket) return { status: 404 };
    if (!/^AWS4-HMAC-SHA256 /.test(init.headers.authorization ?? "")) return { status: 403 };
    const key = parts.slice(1).join("/");
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
      const more = start + 3 < all.length;
      const items = all
        .slice(start, start + 3)
        .map(
          (k) =>
            `<Contents><Key>${k}</Key><LastModified>${objects.get(k).lastModified}</LastModified><Size>${objects.get(k).bytes.length}</Size></Contents>`,
        )
        .join("");
      const next = more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : "";
      return {
        status: 200,
        text: async () =>
          `<ListBucketResult><IsTruncated>${more}</IsTruncated>${next}${items}</ListBucketResult>`,
      };
    }
    const o = objects.get(key);
    return o ? { status: 200, arrayBuffer: async () => o.bytes.buffer.slice(0) } : { status: 404 };
  };
  return { fetchImpl, objects };
}

export const BUCKET_ENV = {
  BACKUP_BUCKET_URL: "https://s3.us-west-004.backblazeb2.com",
  BACKUP_BUCKET_NAME: "praxis-backups",
  BACKUP_BUCKET_KEY_ID: "KEYID-SECRET",
  BACKUP_BUCKET_SECRET: "SECRET-VALUE",
};
