// @vitest-environment node
// V1-S6 / D-713: foreign keys are ON for every connection and every transaction; the auth schema's
// REFERENCES app_user(id) are therefore real. A driver change that turns them off fails here.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { FOREIGN_KEYS_POLICY, foreignKeysEnabled } from "@/lib/db/client";
import { cleanupTempDbs, freshDb, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

describe("foreign-key policy", () => {
  it("is declared ON", () => {
    expect(FOREIGN_KEYS_POLICY).toBe("on");
  });

  it("every new connection, and every transaction on it, has foreign_keys = 1", async () => {
    const a = track(createClient({ url: tempDbUrl() }));
    expect(await foreignKeysEnabled(a)).toBe(true);
    const tx = await a.transaction("write");
    try {
      expect(await foreignKeysEnabled(tx)).toBe(true);
    } finally {
      tx.close();
    }
    const b = track(createClient({ url: tempDbUrl() }));
    expect(await foreignKeysEnabled(b)).toBe(true);
  });

  it("an orphan child row in the migrated auth schema is refused", async () => {
    const auth = await freshDb("auth");
    expect(await foreignKeysEnabled(auth)).toBe(true);
    await expect(
      auth.execute(
        "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (9999, '{}', '2026-01-01T00:00:00.000Z')",
      ),
    ).rejects.toThrow(/FOREIGN KEY|constraint/i);
  });
});
