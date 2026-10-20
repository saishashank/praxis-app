// "What the system learned" loader (UX-070/071/071a, KB-070, UXN-200/201/208; docs/M7_design.md 3 row 21;
// D-136 draft). Lists lessons (with their latest grade), challengers, the knowledge documents and the
// latest nightly plan. Every user reads; Owner actions stay in `learning/ownerActions` and the pages.
// Masking (DAT-124): documents and the plan go through `LearningMasker` (D-129), the same masker as
// `GET /api/learning/*`, so every string in them is masked for a masked user. Lessons and challengers
// carry only ids, template names, versions, grades and states (no code or company), which a test pins.
import { LearningMasker } from "@/lib/learning/mask";
import { listChallengers, listLessons } from "@/lib/learning/ownerActions";
import {
  DOC_TYPES,
  isDocType,
  listDocuments,
  readPlan,
  type DocSummary,
  type DocType,
  type PlanView,
} from "@/lib/learning/readers";
import { marketOf, textParam, type LoaderEnv, type LoaderState } from "./shell";

const FAMILY_RE = /^F[1-6]$/;
const GRADES = ["L0", "L1", "L2", "L3", "retired"] as const;
const DOC_ROWS = 100; // threshold-ok: documents shown at once

export type KnowledgeQuery = { type?: DocType; q?: string; family?: string; grade?: string };

/** `?type=&q=&family=&grade=`: null when a value is not allowed. */
export function parseKnowledgeQuery(sp: URLSearchParams): KnowledgeQuery | null {
  const type = sp.get("type") || undefined;
  const family = sp.get("family") || undefined;
  const grade = sp.get("grade") || undefined;
  const q = textParam(sp.get("q"), 60);
  if (q === null) return null;
  if (type !== undefined && !isDocType(type)) return null;
  if (family !== undefined && !FAMILY_RE.test(family)) return null;
  if (grade !== undefined && !(GRADES as readonly string[]).includes(grade)) return null;
  return { type: type as DocType | undefined, q, family, grade };
}

export type LessonRow = {
  id: string;
  template: string;
  ruleVersion: string;
  createdD: string;
  grade: string | null;
};
export type ChallengerRow = {
  id: string;
  family: string;
  state: string;
  stateD: string;
  origin: string;
  ready: boolean;
  shadowViewed: boolean;
};
export type KnowledgeModel = {
  state: LoaderState;
  masked: boolean;
  docTypes: readonly string[];
  lessons: LessonRow[];
  challengers: ChallengerRow[];
  documents: DocSummary[];
  plan: PlanView | null;
};

export async function loadKnowledge(env: LoaderEnv, q: KnowledgeQuery): Promise<KnowledgeModel> {
  const market = marketOf(env);
  const masked = env.mask.masked;
  const masker = new LearningMasker(env.main, market);
  const lessons = (await listLessons(env.main))
    .filter((x) => q.grade === undefined || String(x.grade) === q.grade)
    .filter((x) => q.family === undefined || String(x.rule_version).startsWith(`${q.family}.`))
    .filter((x) => q.q === undefined || String(x.id).toLowerCase().includes(q.q.toLowerCase()))
    .map((x) => ({
      id: String(x.id),
      template: String(x.template_id),
      ruleVersion: String(x.rule_version),
      createdD: String(x.created_d),
      grade: x.grade === null || x.grade === undefined ? null : String(x.grade),
    }));
  const challengers = (await listChallengers(env.main))
    .filter((x) => q.family === undefined || String(x.family) === q.family)
    .map((x) => ({
      id: String(x.id),
      family: String(x.family),
      state: String(x.state),
      stateD: String(x.state_d),
      origin: String(x.origin),
      ready: Number(x.ready) === 1,
      shadowViewed: x.shadow_viewed_d !== null,
    }));
  let documents = await listDocuments(env.main, {
    market,
    type: q.type,
    q: q.q,
    limit: DOC_ROWS,
  });
  if (q.family !== undefined) {
    documents = documents.filter((x) => x.path.includes(`/${q.family}`));
  }
  let plan: PlanView | null = null;
  try {
    plan = await readPlan(env.main, market);
    if (plan.items.length === 0 && plan.reviews.length === 0) plan = null;
  } catch {
    plan = null;
  }
  if (masked) {
    documents = await masker.documents(documents);
    plan = plan === null ? null : await masker.plan(plan);
  }
  const any = lessons.length + challengers.length + documents.length > 0 || plan !== null;
  return {
    state: any ? "ok" : "empty",
    masked,
    docTypes: DOC_TYPES,
    lessons,
    challengers,
    documents,
    plan,
  };
}
