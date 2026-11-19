// The one writer of a market profile (M19 A1; DAT-242, D-999, NFR-023). Every change to a profile field goes
// through `setProfileField` (or `markFieldVerified` for the evidence of an unchanged value): it validates the
// value against the field's shape, writes the field row, appends one `market_profile_change` ledger row, bumps
// `market_profile.profile_version`, re-projects the `market` row (tz, session, cut-off, currency and the
// Worker's `slots_json`) and invalidates the loader cache, all in one write transaction. A change to a cost,
// tick, slippage, settlement or parcel field is a counted trial (VAL-112): the ledger row says so and one
// `trial_ledger` row is charged per Cortex lineage of that market that already has a split (the same lineages
// and the same `challenger` kind as an Owner key edit, src/lib/cortex/store/keyEdit.ts). A market with no
// lineage yet (IN, US in M19) charges none; the change row still carries `counted_trial = 1`.
// Authorisation and audit belong to the caller: the Configuration page calls this after `updateConfig` has
// checked the Owner and appended the `config.change` audit event (src/lib/config/admin.ts).
import type { Client } from "@libsql/client";
import { COUNTED_TRIAL_FIELDS, PROFILE_FIELDS, validateField } from "./fields.mjs";
import {
  encodeValue,
  profileFromRows,
  type FieldRowInput,
  type MarketRowInput,
  type ProfileRowInput,
} from "./profileCore.mjs";
import { invalidateProfiles } from "./profile";

/** Cortex families whose lineages are charged (F7 is shadow only and has no lineage). */
const CHARGED_FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;

export type SetFieldInput = {
  code: string;
  field: string;
  value: unknown;
  /** Who changed it: a user id as text, or "system". */
  actor: string;
  /** 1 to 200 characters. */
  reason: string;
  /** ISO UTC instant; default now. */
  now?: string;
  /** Evidence for a [VERIFY] field written with the value (date and reference). */
  verified?: { at: string; evidenceRef: string };
};

export type SetFieldResult =
  | {
      ok: true;
      changed: boolean;
      version: number;
      countedTrial: boolean;
      chargedLineages: string[];
      changeId: number | null;
    }
  | { ok: false; error: "invalid" | "unknown_market" | "unknown_field"; message: string };

const fail = (
  error: "invalid" | "unknown_market" | "unknown_field",
  message: string,
): SetFieldResult => ({
  ok: false,
  error,
  message,
});

type Tx = Awaited<ReturnType<Client["transaction"]>>;

async function reproject(tx: Tx, code: string, now: string): Promise<void> {
  const m = await tx.execute({
    sql: "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json FROM market WHERE code = ?",
    args: [code],
  });
  const p = await tx.execute({
    sql: "SELECT code, work_status, status_changed_at, built_at, evidence_recorded_at, profile_version, updated_at FROM market_profile WHERE code = ?",
    args: [code],
  });
  const f = await tx.execute({
    sql: "SELECT field, value_json, verify, verified_at, evidence_ref FROM market_profile_field WHERE code = ?",
    args: [code],
  });
  const profile = profileFromRows({
    market: m.rows[0] as unknown as MarketRowInput,
    profile: p.rows[0] as unknown as ProfileRowInput,
    fieldRows: f.rows as unknown as FieldRowInput[],
  });
  if (
    profile.tz === null ||
    profile.sessionOpen === null ||
    profile.sessionClose === null ||
    profile.decisionCutoff === null ||
    profile.currency === null
  ) {
    return; // a field not set yet: the market row keeps what it has
  }
  await tx.execute({
    sql: `UPDATE market SET tz = ?, open_time = ?, close_time = ?, cutoff_time = ?, currency = ?, slots_json = ?
           WHERE code = ?`,
    args: [
      profile.tz,
      profile.sessionOpen,
      profile.sessionClose,
      profile.decisionCutoff,
      profile.currency,
      profile.slots === null ? null : JSON.stringify(profile.slots),
      code,
    ],
  });
  void now;
}

async function chargeLineages(
  tx: Tx,
  code: string,
  changeId: number,
  field: string,
  d: string,
): Promise<string[]> {
  const charged: string[] = [];
  for (const family of CHARGED_FAMILIES) {
    const lineageId = `${code}:${family}`;
    // rows-ok: primary-key range of one lineage's splits
    const r = await tx.execute({
      sql: "SELECT MAX(version) AS v FROM lineage_split WHERE lineage_id = ?",
      args: [lineageId],
    });
    const v = r.rows[0]?.v;
    if (v === null || v === undefined) continue;
    await tx.execute({
      sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
            VALUES (?, ?, ?, ?, 'challenger', ?, ?, NULL, ?) ON CONFLICT DO NOTHING`,
      args: [
        `profile:${changeId}:${family}`,
        code,
        lineageId,
        Number(v),
        `profile:${family}.change`,
        `field:${field}`,
        d,
      ],
    });
    charged.push(lineageId);
  }
  return charged;
}

async function write(
  db: Client,
  input: Omit<SetFieldInput, "value"> & { value: unknown; keepValue: boolean },
): Promise<SetFieldResult> {
  const { code, field } = input;
  if (!(PROFILE_FIELDS as readonly string[]).includes(field))
    return fail("unknown_field", `unknown profile field ${field}`);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > 200)
    return fail("invalid", "give a reason of 1 to 200 characters");
  if (!input.keepValue) {
    if (input.value === null || input.value === undefined)
      return fail("invalid", "a value is required");
    const problem = validateField(field, input.value);
    if (problem !== null) return fail("invalid", problem);
  }
  const now = input.now ?? new Date().toISOString();
  const tx = await db.transaction("write");
  try {
    const cur = await tx.execute({
      sql: "SELECT value_json, verify, verified_at, evidence_ref FROM market_profile_field WHERE code = ? AND field = ?",
      args: [code, field],
    });
    if (cur.rows.length !== 1) {
      await tx.rollback();
      return fail("unknown_market", `no profile for ${code}`);
    }
    const row = cur.rows[0]!;
    const oldJson = String(row.value_json);
    const newJson = input.keepValue ? oldJson : encodeValue(input.value);
    const flagged = Number(row.verify) === 1;
    const valueChanged = newJson !== oldJson;
    const evidenceChanged =
      input.verified !== undefined &&
      (String(row.verified_at ?? "") !== input.verified.at ||
        String(row.evidence_ref ?? "") !== input.verified.evidenceRef);
    if (!valueChanged && !evidenceChanged) {
      await tx.rollback();
      const v = await db.execute({
        sql: "SELECT profile_version FROM market_profile WHERE code = ?",
        args: [code],
      });
      return {
        ok: true,
        changed: false,
        version: Number(v.rows[0]?.profile_version ?? 0),
        countedTrial: false,
        chargedLineages: [],
        changeId: null,
      };
    }
    // a changed [VERIFY] value needs its evidence again, unless the caller supplies it with the value
    const verifiedAt =
      input.verified !== undefined
        ? input.verified.at
        : valueChanged && flagged
          ? null
          : (row.verified_at as string | null);
    const evidenceRef =
      input.verified !== undefined
        ? input.verified.evidenceRef
        : valueChanged && flagged
          ? null
          : (row.evidence_ref as string | null);
    const counted = valueChanged && (COUNTED_TRIAL_FIELDS as readonly string[]).includes(field);
    await tx.execute({
      sql: `UPDATE market_profile_field SET value_json = ?, verified_at = ?, evidence_ref = ?, updated_at = ?
             WHERE code = ? AND field = ?`,
      args: [newJson, verifiedAt, evidenceRef, now, code, field],
    });
    const ins = await tx.execute({
      sql: `INSERT INTO market_profile_change (code, field, old_json, new_json, changed_at, actor, reason, counted_trial, trial_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      args: [code, field, oldJson, newJson, now, input.actor, reason, counted ? 1 : 0],
    });
    const changeId = Number(ins.lastInsertRowid);
    const charged = counted
      ? await chargeLineages(tx, code, changeId, field, now.slice(0, 10))
      : [];
    await tx.execute({
      sql: "UPDATE market_profile SET profile_version = profile_version + 1, updated_at = ? WHERE code = ?",
      args: [now, code],
    });
    if (valueChanged) await reproject(tx, code, now);
    const v = await tx.execute({
      sql: "SELECT profile_version FROM market_profile WHERE code = ?",
      args: [code],
    });
    await tx.commit();
    invalidateProfiles();
    return {
      ok: true,
      changed: true,
      version: Number(v.rows[0]!.profile_version),
      countedTrial: counted,
      chargedLineages: charged,
      changeId,
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // already closed
    }
    throw err;
  } finally {
    tx.close();
  }
}

/**
 * Sets one field of a market profile (the one writer, D-999). A second write of the same value is a no-op.
 * Throws only for a database error; a refusal is a result.
 */
export async function setProfileField(db: Client, input: SetFieldInput): Promise<SetFieldResult> {
  return write(db, { ...input, keepValue: false });
}

/** Records the date and evidence of an unchanged [VERIFY] value (DAT-242; used from M20). */
export async function markFieldVerified(
  db: Client,
  input: Omit<SetFieldInput, "value" | "verified"> & {
    verified: { at: string; evidenceRef: string };
  },
): Promise<SetFieldResult> {
  return write(db, { ...input, value: undefined, keepValue: true });
}
