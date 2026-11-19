// @vitest-environment node
// Discovery (M22 E2; DAT-229, D-1433): co-mentions in tracked experts' own headlines only; no network; a candidate is
// `candidate`/`discovered` with its facts in the poll state; known people are skipped; at most ten a week; a dismissed one is
// never proposed again; one run a week-day.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  candidateId,
  coMentions,
  MAX_NEW_PER_WEEK,
  runDiscovery,
} from "@/lib/experts/poll/discovery";
import { insertItem } from "@/lib/experts/poll/store";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld } from "../uiWorld";
import { rowsOf } from "./helpers";

afterAll(cleanupTempDbs);

let main: Client;
beforeEach(async () => {
  main = (await zzWorld()).main;
});

const DAY = "2030-03-10"; // a Sunday
const at = () => new Date(`${DAY}T10:00:00.000Z`);
let n = 0;
const title = (expert: string, t: string) =>
  insertItem(main, {
    expertId: expert,
    url: `https://${expert.toLowerCase()}.example.test/d/${n++}`,
    platform: "site",
    title: t,
    publishedAt: null,
    summary: null,
    ingestedAt: "2030-03-01T00:00:00.000Z",
  });

describe("coMentions (pure)", () => {
  it("a handle named by two different experts counts; one expert naming it twice does not", () => {
    const m = coMentions([
      { expertId: "a", title: "Chat with @newvoice about trends" },
      { expertId: "b", title: "Why @NewVoice is worth a listen" },
      { expertId: "a", title: "@solo says @solo again" },
      { expertId: "a", title: "@solo once more" },
    ]);
    expect(m).toEqual([{ handle: "newvoice", experts: ["a", "b"], count: 2 }]);
  });
  it("ignores e-mail addresses, short handles and a handle glued to other text", () => {
    expect(
      coMentions([
        { expertId: "a", title: "write to name@example.test or @ab or x@@bogus" },
        { expertId: "b", title: "name@example.test and @ab" },
      ]),
    ).toEqual([]);
  });
  it("orders by experts, then mentions, then handle", () => {
    const rows = [
      { expertId: "a", title: "@bbb @aaa" },
      { expertId: "b", title: "@bbb @aaa" },
      { expertId: "c", title: "@bbb" },
    ];
    expect(coMentions(rows).map((x) => x.handle)).toEqual(["bbb", "aaa"]);
  });
});

describe("runDiscovery", () => {
  it("adds a candidate for a handle two tracked experts name, with its facts; nothing is fetched", async () => {
    await title("X-ZZ1", "A talk with @freshvoice on momentum");
    await title("X-ZZ2", "Notes from @freshvoice");
    const rep = await runDiscovery(main, { now: at, day: DAY });
    expect(rep).toMatchObject({ considered: 1, added: 1, skipped: null });
    const r = await rowsOf(main, "SELECT * FROM expert WHERE id = ?", [candidateId("freshvoice")]);
    expect(r[0]).toMatchObject({
      name: "@freshvoice",
      status: "candidate",
      tier: "discovered",
      licence_status: "unchecked",
      platforms_json: "[]",
      handles_json: "{}",
      home_urls_json: "[]",
      no_feed: 0,
    });
    expect(JSON.parse(String(r[0]!.poll_json))).toEqual({
      disc: { n: 2, by: ["X-ZZ1", "X-ZZ2"], d: DAY },
    });
    const run = await rowsOf(
      main,
      "SELECT counts_json FROM expert_poll_run WHERE kind = 'discovery'",
    );
    expect(JSON.parse(String(run[0]!.counts_json))).toEqual({ considered: 1, added: 1, known: 0 });
  });

  it("a handle that already belongs to an expert is not proposed", async () => {
    await title("X-ZZ1", "With @zz-handle-3 today");
    await title("X-ZZ2", "More from @zz-handle-3");
    const rep = await runDiscovery(main, { now: at, day: DAY });
    expect(rep).toMatchObject({ added: 0, known: 1 });
  });

  it("titles of experts that are not tracked do not count", async () => {
    await title("X-ZZ1", "Hello @quietone");
    await title("X-ZZ6", "Hello @quietone"); // retired
    expect((await runDiscovery(main, { now: at, day: DAY })).considered).toBe(0);
  });

  it("at most ten new people a week", async () => {
    for (let i = 0; i < MAX_NEW_PER_WEEK + 2; i++) {
      await title("X-ZZ1", `Guest @voice${String(i).padStart(2, "0")} joins`);
      await title("X-ZZ2", `Guest @voice${String(i).padStart(2, "0")} again`);
    }
    const rep = await runDiscovery(main, { now: at, day: DAY });
    expect(rep.added).toBe(MAX_NEW_PER_WEEK);
    expect(
      Number(
        (await rowsOf(main, "SELECT COUNT(*) AS n FROM expert WHERE tier = 'discovered'"))[0]!.n,
      ),
    ).toBe(MAX_NEW_PER_WEEK);
  });

  it("one run a day; a dismissed candidate is never proposed again", async () => {
    await title("X-ZZ1", "Hello @fleeting");
    await title("X-ZZ2", "Hello @fleeting");
    await runDiscovery(main, { now: at, day: DAY });
    expect((await runDiscovery(main, { now: at, day: DAY })).skipped).toBe("already_ran");
    await main.execute({
      sql: "UPDATE expert SET status = 'retired' WHERE id = ?",
      args: [candidateId("fleeting")],
    });
    const next = await runDiscovery(main, {
      now: () => new Date("2030-03-17T10:00:00.000Z"),
      day: "2030-03-17",
    });
    expect(next.added).toBe(0);
    expect(
      Number(
        (
          await rowsOf(main, "SELECT COUNT(*) AS n FROM expert WHERE id = ?", [
            candidateId("fleeting"),
          ])
        )[0]!.n,
      ),
    ).toBe(1);
  });

  it("a hostile handle-like title cannot inject anything: the name is only the matched handle characters", async () => {
    await title("X-ZZ1", "@evil.user<script>alert(1)</script> hello");
    await title("X-ZZ2", "@evil.user<script> again");
    await runDiscovery(main, { now: at, day: DAY });
    const names = (await rowsOf(main, "SELECT name FROM expert WHERE tier = 'discovered'")).map(
      (x) => String(x.name),
    );
    for (const nm of names) expect(nm).toMatch(/^@[A-Za-z0-9][A-Za-z0-9_.-]{2,29}$/);
  });
});
