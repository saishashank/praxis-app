// The learning loop's C.9 keys from the configuration store (src/lib/config/keys.ts LEARN_KEY_NAMES):
// one read per key, falling back to the pre-registered default (LEARN_CONFIG_SPEC) for a value that is
// missing or out of its bounds, so the stages always run on a valid configuration. The "derived" rows
// of the spec are code, not Owner keys, and keep their defaults.
import type { Client } from "@libsql/client";
import { isConfigKey } from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { learnConfig, LEARN_CONFIG_SPEC, type LearnConfig, type LearnConfigKey } from "./config";

export async function loadLearnConfig(db: Pick<Client, "execute">): Promise<LearnConfig> {
  const overrides: Partial<Record<LearnConfigKey, number>> = {};
  for (const [k, spec] of Object.entries(LEARN_CONFIG_SPEC) as [
    LearnConfigKey,
    (typeof LEARN_CONFIG_SPEC)[LearnConfigKey],
  ][]) {
    if (spec.source !== "C.9" || !isConfigKey(spec.key)) continue;
    let v: unknown;
    try {
      v = await getConfig(db, spec.key);
    } catch {
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    try {
      learnConfig({ [k]: v });
      overrides[k] = v;
    } catch {
      // out of bounds: the default stays (the config writer refuses such a value anyway)
    }
  }
  return learnConfig(overrides as Partial<LearnConfig>);
}
