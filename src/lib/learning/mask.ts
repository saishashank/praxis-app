// Masking of the learning routes' bodies for non-Owners (DAT-124, ROL-107, UX-009; D-129). Server
// only. Plan items, reviews and knowledge documents can name codes, company names, prices and links
// in any string, so every string (and every object key) of a response is passed through maskText with
// the active set of the record's own date. A record with no usable date gets an empty set, so every
// known code in it becomes "Another stock". Dates kept as-is: the record's own `d` fields.
import type { Client } from "@libsql/client";
import { activeCodesForDate } from "@/lib/view/active";
import { loadMaskLookup, maskText, StockAliases, type MaskLookup } from "@/lib/view/mask";
import type { DocFull, DocSummary, PlanView } from "./readers";

type Db = Pick<Client, "execute">;
const DATE = /^\d{4}-\d{2}-\d{2}$/; // threshold-ok: ISO date shape (YYYY), not a rule

/** Memoises the lookup and the per-date alias sets of one request. */
export class LearningMasker {
  private lookup: MaskLookup | null = null;
  private readonly sets = new Map<string, StockAliases>();
  constructor(
    private readonly db: Db,
    private readonly market: string,
  ) {}

  private async look(): Promise<MaskLookup> {
    return (this.lookup ??= await loadMaskLookup(this.db, this.market));
  }
  private async aliases(d: string | null): Promise<StockAliases> {
    const key = d !== null && DATE.test(d) ? d : "";
    let a = this.sets.get(key);
    if (!a) {
      a = new StockAliases(key === "" ? [] : await activeCodesForDate(this.db, this.market, key));
      this.sets.set(key, a);
    }
    return a;
  }

  /** Deep copy of `v` with every string and object key masked; numbers and booleans pass through. */
  private walk(v: unknown, a: StockAliases, l: MaskLookup): unknown {
    if (typeof v === "string") return maskText(v, a, l);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, a, l));
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [maskText(k, a, l), this.walk(x, a, l)]),
      );
    }
    return v;
  }

  async plan(p: PlanView): Promise<PlanView> {
    const a = await this.aliases(p.d);
    const l = await this.look();
    const s = (x: string): string => maskText(x, a, l);
    return {
      market: p.market,
      d: p.d,
      items: p.items.map((i) => ({
        rank: i.rank,
        kind: s(i.kind),
        reason: s(i.reason),
        lesson_id: i.lesson_id === null ? null : s(i.lesson_id),
        lane: s(i.lane),
        measure: this.walk(i.measure, a, l),
      })),
      reviews: p.reviews.map((r) => ({
        rank: r.rank,
        reviewed_d: r.reviewed_d,
        outcome: s(r.outcome),
        evidence: this.walk(r.evidence, a, l),
      })),
    };
  }

  async document<T extends DocSummary | DocFull>(doc: T): Promise<T> {
    const a = await this.aliases(doc.d);
    const l = await this.look();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc)) {
      out[k] = k === "version" || k === "d" ? v : this.walk(v, a, l);
    }
    return out as T;
  }

  async documents<T extends DocSummary | DocFull>(docs: readonly T[]): Promise<T[]> {
    const out: T[] = [];
    for (const d of docs) out.push(await this.document(d));
    return out;
  }
}
