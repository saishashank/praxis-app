// @vitest-environment node
// M6 T14 Owner/Editor routes (TST-122, ROL-102, ROL-102b, KB-050/051, UX-071a; D-125 draft) against
// real migrated databases. Covers: the role matrix (Owner / Editor / Viewer / anonymous) on every
// route, audit-first ordering and `_failed` events, the data-only refusal, each action reaching its
// writer, the killed-family second confirmation, annotation masking and history.
//
// Routes covered (the route coverage manifest matches these paths):
//   api/learning/challengers, api/learning/lessons, api/learning/annotations,
//   api/learning/challengers/[id]/approve|reject|force-apply|retire|shadow-viewed,
//   api/learning/families/[family]/rollback|versions, api/learning/lessons/[id]/force-apply|retire.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/session";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { f1With, LEARNING, ownerChallenger, rows, world } from "./challengerFixtures";

const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), forbidden: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import * as annotationsRoute from "@/app/api/learning/annotations/route";
import * as approveRoute from "@/app/api/learning/challengers/[id]/approve/route";
import * as forceRoute from "@/app/api/learning/challengers/[id]/force-apply/route";
import * as rejectRoute from "@/app/api/learning/challengers/[id]/reject/route";
import * as retireRoute from "@/app/api/learning/challengers/[id]/retire/route";
import * as shadowRoute from "@/app/api/learning/challengers/[id]/shadow-viewed/route";
import * as challengersRoute from "@/app/api/learning/challengers/route";
import * as rollbackRoute from "@/app/api/learning/families/[family]/rollback/route";
import * as versionsRoute from "@/app/api/learning/families/[family]/versions/route";
import * as lessonForceRoute from "@/app/api/learning/lessons/[id]/force-apply/route";
import * as lessonRetireRoute from "@/app/api/learning/lessons/[id]/retire/route";
import * as lessonsRoute from "@/app/api/learning/lessons/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const BASE = "https://praxis-host.vercel.app";
let main: Client;
let auth: Client;
let owner: CurrentUser;
let editor: CurrentUser;
let editor2: CurrentUser;
let viewer: CurrentUser;

const mkUser = async (email: string, role: CurrentUser["role"]): Promise<CurrentUser> => ({
  id: await addUser(auth, { email, role }),
  email,
  name: null,
  role,
});

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  main = (await world(["F1"])).db;
  await main.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  owner = await mkUser("owner@example.test", "owner");
  editor = await mkUser("editor@example.test", "editor");
  editor2 = await mkUser("editor2@example.test", "editor");
  viewer = await mkUser("viewer@example.test", "viewer");
  mem.user = owner;
});

const req = (path: string, method = "POST", body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const famCtx = (family: string) => ({ params: Promise.resolve({ family }) });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const OK = { confirm: true };

/** An Owner challenger in `review` (ready) or `approved`, through the real transitions. */
async function challengerIn(i: number, state: "review" | "approved" = "review"): Promise<string> {
  const made = await ownerChallenger(main, i);
  if (made.status !== "created") throw new Error(JSON.stringify(made));
  const id = made.id;
  const go = (to: "replay" | "shakedown" | "review" | "approved") =>
    transitionChallenger(
      main,
      { id, to, d: "2026-10-05", actor: "u-owner", reason: `t ${to}` },
      { shakedownSessions: LEARNING.shakedownSessions },
    );
  await go("replay");
  await go("shakedown");
  await main.execute({
    sql: "UPDATE challenger SET shakedown_ok_sessions = ? WHERE id = ?",
    args: [LEARNING.shakedownSessions, id],
  });
  await go("review");
  await main.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [id] });
  if (state === "approved") await go("approved");
  return id;
}

async function addLesson(id = "L-AU-t-abcd1234-F1.v1"): Promise<string> {
  await main.execute({
    sql: `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version,
            subject_json, rule_version, metric, direction, created_d, created_run)
          VALUES (?, 'AU', 'market', NULL, 't', 1, '{}', 'F1.v1', 'm', 1, '2026-10-05', 'r')`,
    args: [id],
  });
  await main.execute({
    sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, n, blocks, B, state_text, run_id, d)
          VALUES (?, 1, 'L0', 0, 5, 1, 0, 'obs', 'r', '2026-10-05')`,
    args: [id],
  });
  return id;
}

const actions = async (like: string) =>
  (await auditRows(auth)).filter((x) => String(x.action).startsWith(like));
const count = async (sql: string) => Number((await rows(main, sql))[0]!.n);

// ---- role matrix -------------------------------------------------------------------------------------------------

describe("role matrix (TST-122)", () => {
  type Call = () => Promise<Response>;
  const owner_only: Array<[string, Call]> = [
    [
      "approve",
      () => approveRoute.POST(req("/api/learning/challengers/x/approve", "POST", OK), idCtx("x")),
    ],
    [
      "reject",
      () => rejectRoute.POST(req("/api/learning/challengers/x/reject", "POST", OK), idCtx("x")),
    ],
    [
      "force-apply",
      () => forceRoute.POST(req("/api/learning/challengers/x/force-apply", "POST", OK), idCtx("x")),
    ],
    [
      "retire",
      () => retireRoute.POST(req("/api/learning/challengers/x/retire", "POST", OK), idCtx("x")),
    ],
    [
      "shadow-viewed",
      () => shadowRoute.POST(req("/api/learning/challengers/x/shadow-viewed"), idCtx("x")),
    ],
    [
      "rollback",
      () => rollbackRoute.POST(req("/api/learning/families/F1/rollback", "POST", OK), famCtx("F1")),
    ],
    [
      "versions",
      () => versionsRoute.POST(req("/api/learning/families/F1/versions", "POST", {}), famCtx("F1")),
    ],
    [
      "lesson force-apply",
      () =>
        lessonForceRoute.POST(req("/api/learning/lessons/x/force-apply", "POST", OK), idCtx("x")),
    ],
    [
      "lesson retire",
      () => lessonRetireRoute.POST(req("/api/learning/lessons/x/retire", "POST", OK), idCtx("x")),
    ],
  ];

  it.each(owner_only)(
    "%s: anonymous 401, Viewer and Editor 403 (audited), Owner passes the gate",
    async (_n, call) => {
      mem.user = null;
      expect((await call()).status).toBe(401);
      for (const u of [viewer, editor]) {
        mem.user = u;
        expect((await call()).status).toBe(403);
      }
      expect((await actions("auth.forbidden")).length).toBe(2);
      mem.user = owner;
      expect([400, 404, 409]).toContain((await call()).status); // past the gate: unknown id / bad input
    },
  );

  it("reads: every signed-in role may list; anonymous is refused", async () => {
    for (const u of [owner, editor, viewer]) {
      mem.user = u;
      expect(
        (await challengersRoute.GET(req("/api/learning/challengers", "GET"), undefined)).status,
      ).toBe(200);
      expect((await lessonsRoute.GET(req("/api/learning/lessons", "GET"), undefined)).status).toBe(
        200,
      );
    }
    mem.user = null;
    expect((await lessonsRoute.GET(req("/api/learning/lessons", "GET"), undefined)).status).toBe(
      401,
    );
  });

  it("annotations: write needs Editor or Owner; Viewer and anonymous are refused", async () => {
    const post = () =>
      annotationsRoute.POST(
        req("/api/learning/annotations", "POST", {
          subject_kind: "card",
          subject_id: "c1",
          text: "hi",
        }),
        undefined,
      );
    mem.user = null;
    expect((await post()).status).toBe(401);
    mem.user = viewer;
    expect((await post()).status).toBe(403);
    for (const u of [editor, owner]) {
      mem.user = u;
      expect((await post()).status).toBe(200);
    }
  });
});

// ---- data-only, confirmation, audit-first ---------------------------------------------------------------------

describe("refusals before any audit row", () => {
  it("data-only market: Owner routes refuse, no audit row, no change; annotations still work", async () => {
    const id = await challengerIn(1);
    await main.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    const r = await approveRoute.POST(req("/x", "POST", OK), idCtx(id));
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("market_data_only");
    expect(await actions("learning.")).toHaveLength(0);
    mem.user = editor;
    const a = await annotationsRoute.POST(
      req("/x", "POST", { subject_kind: "card", subject_id: "c", text: "note" }),
      undefined,
    );
    expect(a.status).toBe(200);
  });

  it("a destructive action without confirm is refused with no audit row", async () => {
    const id = await challengerIn(1);
    const r = await rejectRoute.POST(req("/x", "POST", {}), idCtx(id));
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("confirmation_required");
    expect(await actions("learning.")).toHaveLength(0);
  });

  it("an unconfigured audit key fails closed: 503 and no change", async () => {
    const id = await challengerIn(1);
    vi.stubEnv("PII_HASH_KEY", "");
    const r = await rejectRoute.POST(req("/x", "POST", OK), idCtx(id));
    expect(r.status).toBe(503);
    expect(await rows(main, "SELECT state FROM challenger WHERE id = ?", [id])).toEqual([
      { state: "review" },
    ]);
  });
});

describe("audit-first and _failed events", () => {
  it("the audit event id is the reference stored by the writer (force-apply)", async () => {
    const id = await challengerIn(1);
    const r = await forceRoute.POST(req("/x", "POST", OK), idCtx(id));
    expect(r.status).toBe(200);
    const ev = (await actions("learning.challenger_force_apply"))[0]!;
    const ledger = await rows(
      main,
      "SELECT audit_ref, actor FROM change_ledger WHERE kind = 'force_apply'",
    );
    expect(ledger).toEqual([{ audit_ref: `audit:${String(ev.id)}`, actor: `u${owner.id}` }]);
    expect(ev.actor_user_id).toBe(owner.id);
  });

  it("a refused writer leaves the audit row plus a _failed row and no change", async () => {
    const id = await challengerIn(1);
    await forceRoute.POST(req("/x", "POST", OK), idCtx(id)); // pending change exists now
    const again = await forceRoute.POST(req("/x", "POST", OK), idCtx(id)); // same request: idempotent
    expect(again.status).toBe(200);
    const other = await challengerIn(2);
    const r = await forceRoute.POST(req("/x", "POST", OK), idCtx(other));
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("pending_exists");
    expect(await actions("learning.challenger_force_apply_failed")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM promotion")).toBe(1);
  });

  it("a thrown writer error appends _failed", async () => {
    const id = await challengerIn(1);
    await main.execute("DROP TRIGGER IF EXISTS no_such_trigger");
    await main.execute({ sql: "UPDATE challenger SET state = 'review' WHERE id = ?", args: [id] });
    // approving a challenger that is not ready is refused by the lifecycle (throws ChallengerError)
    await main.execute({ sql: "UPDATE challenger SET ready = 0 WHERE id = ?", args: [id] });
    const r = await approveRoute.POST(req("/x", "POST", OK), idCtx(id));
    expect(r.status).toBe(409);
    expect(await actions("learning.challenger_approve_failed")).toHaveLength(1);
    expect(await rows(main, "SELECT state FROM challenger WHERE id = ?", [id])).toEqual([
      { state: "review" },
    ]);
  });
});

// ---- each action reaches the right writer -------------------------------------------------------------------------

describe("actions reach their writers", () => {
  it("approve: review -> approved by the Owner, then a pending promotion with the audit reference", async () => {
    const id = await challengerIn(1);
    const r = await approveRoute.POST(req("/x", "POST", OK), idCtx(id));
    expect(r.status).toBe(200);
    const body = await json(r);
    expect((body.promotion as { status: string }).status).toBe("scheduled");
    expect(await rows(main, "SELECT state FROM challenger WHERE id = ?", [id])).toEqual([
      { state: "approved" },
    ]);
    const ev = await rows(
      main,
      "SELECT actor FROM challenger_event WHERE challenger_id = ? AND to_state = 'approved'",
      [id],
    );
    expect(ev).toEqual([{ actor: `u${owner.id}` }]);
    expect(await rows(main, "SELECT kind, status FROM promotion")).toEqual([
      { kind: "promotion", status: "pending" },
    ]);
    const ref = await rows(main, "SELECT audit_ref FROM change_ledger WHERE kind = 'promotion'");
    expect(ref[0]!.audit_ref).toBe(`audit:${String(body.auditId)}`);
  });

  it("reject: review -> rejected", async () => {
    const id = await challengerIn(1);
    expect(
      (await rejectRoute.POST(req("/x", "POST", { ...OK, reason: "no" }), idCtx(id))).status,
    ).toBe(200);
    expect(await rows(main, "SELECT state, ready FROM challenger WHERE id = ?", [id])).toEqual([
      { state: "rejected", ready: 0 },
    ]);
  });

  it("retire: the challenger and its version are retired", async () => {
    const id = await challengerIn(1);
    expect((await retireRoute.POST(req("/x", "POST", OK), idCtx(id))).status).toBe(200);
    expect(await rows(main, "SELECT state FROM challenger WHERE id = ?", [id])).toEqual([
      { state: "retired" },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM change_ledger WHERE kind = 'retire'")).toBe(1);
  });

  it("shadow-viewed: recorded once per day, audited only when it changes", async () => {
    const id = await challengerIn(1);
    const first = await json(await shadowRoute.POST(req("/x"), idCtx(id)));
    expect(first.changed).toBe(true);
    const second = await json(await shadowRoute.POST(req("/x"), idCtx(id)));
    expect(second.changed).toBe(false);
    expect(await actions("learning.challenger_shadow_viewed")).toHaveLength(1);
    expect(
      (await rows(main, "SELECT shadow_viewed_d FROM challenger WHERE id = ?", [id]))[0]!
        .shadow_viewed_d,
    ).not.toBeNull();
  });

  it("owner version: values over the live version become a challenger; bad key or bound is refused", async () => {
    const ok = await versionsRoute.POST(
      req("/x", "POST", { params: { f1_trail_atr: 2.5 } }),
      famCtx("F1"),
    );
    expect(ok.status).toBe(200);
    expect(await rows(main, "SELECT origin, state FROM challenger")).toEqual([
      { origin: "owner", state: "proposed" },
    ]);
    const badKey = await versionsRoute.POST(
      req("/x", "POST", { params: { nope: 1 } }),
      famCtx("F1"),
    );
    expect(badKey.status).toBe(409);
    const badBound = await versionsRoute.POST(
      req("/x", "POST", { params: { f1_trail_atr: 99 } }),
      famCtx("F1"),
    );
    expect(badBound.status).toBe(409);
    expect((await versionsRoute.POST(req("/x", "POST", { params: {} }), famCtx("F1"))).status).toBe(
      400,
    );
    expect(
      (await versionsRoute.POST(req("/x", "POST", { params: { f1_trail_atr: 2.5 } }), famCtx("ZZ")))
        .status,
    ).toBe(400);
    expect(await actions("learning.owner_version_failed")).toHaveLength(2);
    expect(await f1With(main, {})).toBeTruthy();
  });

  it("rollback: a new rollback version is scheduled; confirmation is required", async () => {
    const made = await ownerChallenger(main, 3);
    if (made.status !== "created") throw new Error("x");
    await main.execute({
      sql: `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
            VALUES (?, 2, 'live', '2026-10-05', 't')`,
      args: [made.ruleVersionId],
    });
    expect(
      (await rollbackRoute.POST(req("/x", "POST", { to_version: "F1.v1" }), famCtx("F1"))).status,
    ).toBe(409);
    expect(await actions("learning.")).toHaveLength(0);
    const r = await rollbackRoute.POST(
      req("/x", "POST", { ...OK, to_version: "F1.v1" }),
      famCtx("F1"),
    );
    expect(r.status).toBe(200);
    expect(await rows(main, "SELECT kind, status FROM promotion")).toEqual([
      { kind: "rollback", status: "pending" },
    ]);
    const bad = await rollbackRoute.POST(
      req("/x", "POST", { ...OK, to_version: "F1.v9" }),
      famCtx("F1"),
    );
    expect(bad.status).toBe(409);
  });

  it("lesson force-apply and retire", async () => {
    const id = await addLesson();
    expect((await lessonForceRoute.POST(req("/x", "POST", OK), idCtx(id))).status).toBe(200);
    expect(
      await rows(main, "SELECT kind, audit_ref FROM change_ledger WHERE kind = 'lesson_force'"),
    ).toHaveLength(1);
    expect((await lessonRetireRoute.POST(req("/x", "POST", OK), idCtx(id))).status).toBe(200);
    expect(
      await rows(
        main,
        "SELECT grade FROM lesson_grade WHERE lesson_id = ? ORDER BY seq DESC LIMIT 1",
        [id],
      ),
    ).toEqual([{ grade: "retired" }]);
    const again = await json(await lessonRetireRoute.POST(req("/x", "POST", OK), idCtx(id)));
    expect(again.changed).toBe(false);
    expect((await lessonRetireRoute.POST(req("/x", "POST", OK), idCtx("L-none"))).status).toBe(404);
  });
});

// ---- killed family: second confirmation ---------------------------------------------------------------------------

describe("killed family", () => {
  beforeEach(async () => {
    await main.execute(
      "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason) VALUES ('family','F1','killed','2026-10-05T00:00:00Z','x','t')",
    );
  });

  it("force-apply needs a second confirmation; with it the request is written", async () => {
    const id = await challengerIn(1);
    const first = await forceRoute.POST(req("/x", "POST", OK), idCtx(id));
    expect(first.status).toBe(409);
    expect((await json(first)).error).toBe("second_confirmation_required");
    expect(await actions("learning.")).toHaveLength(0);
    const second = await forceRoute.POST(
      req("/x", "POST", { ...OK, confirm_killed: true }),
      idCtx(id),
    );
    expect(second.status).toBe(200);
    expect((await actions("learning.challenger_force_apply"))[0]!.detail).toMatchObject({
      confirmKilled: true,
    });
  });

  it("rollback needs the second confirmation too", async () => {
    const made = await ownerChallenger(main, 3);
    if (made.status !== "created") throw new Error("x");
    await main.execute({
      sql: `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason) VALUES (?, 2, 'live', '2026-10-05', 't')`,
      args: [made.ruleVersionId],
    });
    const a = await rollbackRoute.POST(
      req("/x", "POST", { ...OK, to_version: "F1.v1" }),
      famCtx("F1"),
    );
    expect((await json(a)).error).toBe("second_confirmation_required");
    const b = await rollbackRoute.POST(
      req("/x", "POST", { ...OK, to_version: "F1.v1", confirm_killed: true }),
      famCtx("F1"),
    );
    expect(b.status).toBe(200);
  });

  it("approve of a killed family keeps the approval but the promotion is refused (frozen)", async () => {
    const id = await challengerIn(1);
    const r = await json(await approveRoute.POST(req("/x", "POST", OK), idCtx(id)));
    expect((r.promotion as { reason: string }).reason).toBe("family_frozen");
    expect(await count("SELECT COUNT(*) AS n FROM promotion")).toBe(0);
  });
});

// ---- annotations --------------------------------------------------------------------------------------------------

describe("annotations", () => {
  const add = async (u: CurrentUser, text = "first note", kind = "card", subject = "c1") => {
    mem.user = u;
    return annotationsRoute.POST(
      req("/api/learning/annotations", "POST", { subject_kind: kind, subject_id: subject, text }),
      undefined,
    );
  };
  const list = async (u: CurrentUser, extra = "") => {
    mem.user = u;
    return json(
      await annotationsRoute.GET(
        req(`/api/learning/annotations?subject_kind=card&subject_id=c1${extra}`, "GET"),
        undefined,
      ),
    );
  };

  it("validation: length, kind, empty text, unknown lesson", async () => {
    expect((await add(editor, "x".repeat(1001))).status).toBe(400);
    expect((await add(editor, "   ")).status).toBe(400);
    expect((await add(editor, "ok", "bogus")).status).toBe(400);
    expect((await add(editor, "ok", "lesson", "L-none")).status).toBe(404);
    expect((await add(editor, "x".repeat(1000))).status).toBe(200);
  });

  it("masking: Owner and Editor see text, a Viewer sees only the role and date", async () => {
    await add(editor, "private words");
    for (const u of [owner, editor2]) {
      const l = (await list(u)).annotations as Array<Record<string, unknown>>;
      expect(l[0]!.text).toBe("private words");
    }
    const v = (await list(viewer)).annotations as Array<Record<string, unknown>>;
    expect(v[0]!.text).toBeNull();
    expect(v[0]!.masked).toBe(true);
    expect(String(v[0]!.note)).toMatch(/^Note added by editor on \d{4}-\d\d-\d\d$/);
    expect(JSON.stringify(v)).not.toContain("private words");
    // a Viewer cannot ask for the history
    expect(JSON.stringify(await list(viewer, "&history=1"))).not.toContain("private words");
  });

  it("edit and delete: author or Owner only; history keeps every version; every change is audited", async () => {
    await add(editor, "v1");
    const id = Number(((await list(owner)).annotations as Array<{ id: number }>)[0]!.id);
    mem.user = editor2;
    expect(
      (await annotationsRoute.PATCH(req("/x", "PATCH", { id, text: "hijack" }), undefined)).status,
    ).toBe(403);
    expect((await annotationsRoute.DELETE(req("/x", "DELETE", { id }), undefined)).status).toBe(
      403,
    );
    mem.user = editor;
    expect(
      (await annotationsRoute.PATCH(req("/x", "PATCH", { id, text: "v2" }), undefined)).status,
    ).toBe(200);
    expect(
      (await annotationsRoute.PATCH(req("/x", "PATCH", { id, text: "v2" }), undefined)).status,
    ).toBe(409);
    mem.user = owner;
    expect(
      (await annotationsRoute.PATCH(req("/x", "PATCH", { id, text: "v3 by owner" }), undefined))
        .status,
    ).toBe(200);
    const h = (
      (await list(owner, "&history=1")).annotations as Array<{
        text: string;
        history: Array<Record<string, unknown>>;
      }>
    )[0]!;
    expect(h.text).toBe("v3 by owner");
    expect(h.history.map((x) => [x.op, x.before, x.after])).toEqual([
      ["edit", "v1", "v2"],
      ["edit", "v2", "v3 by owner"],
    ]);
    mem.user = editor;
    expect((await annotationsRoute.DELETE(req("/x", "DELETE", { id }), undefined)).status).toBe(
      200,
    );
    expect(((await list(owner)).annotations as unknown[]).length).toBe(0);
    expect((await annotationsRoute.DELETE(req("/x", "DELETE", { id }), undefined)).status).toBe(
      404,
    );
    const hist = await rows(auth, "SELECT op FROM annotation_history ORDER BY id");
    expect(hist.map((x) => x.op)).toEqual(["edit", "edit", "delete"]);
    const acts = (await actions("annotation.")).map((x) => x.action);
    expect(acts).toEqual([
      "annotation.add",
      "annotation.edit",
      "annotation.edit",
      "annotation.delete",
    ]);
    // the text never goes into the audit detail
    expect(JSON.stringify(await actions("annotation."))).not.toContain("v2");
  });

  it("an annotation failure rolls the audit event back with it and appends _failed", async () => {
    await add(editor, "v1");
    const id = Number(((await list(owner)).annotations as Array<{ id: number }>)[0]!.id);
    await auth.execute(
      "CREATE TRIGGER t_fail BEFORE INSERT ON annotation_history BEGIN SELECT RAISE(ABORT, 'x'); END",
    );
    mem.user = editor;
    const r = await annotationsRoute.PATCH(req("/x", "PATCH", { id, text: "v2" }), undefined);
    expect(r.status).toBe(503);
    expect(await actions("annotation.edit")).toHaveLength(1);
    expect((await actions("annotation.edit"))[0]!.action).toBe("annotation.edit_failed");
    expect(await rows(auth, "SELECT text FROM annotation WHERE id = ?", [id])).toEqual([
      { text: "v1" },
    ]);
  });
});
