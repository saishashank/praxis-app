// M7 T18 pages: What the system learned (KB-070, UX-070/071/071a, UXN-200/201/208). Rendered from a real
// temporary database through the page components: content, Owner-only controls, rules-only output for
// masked users, notes, the compare page's honest labels, axe, and the 360 px class rules.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { CODES, envOf, NAMES, type Who } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { findLeaks } from "@/lib/view/mask";
import LearnedPage from "@/app/(app)/reviews/learned/page";
import ComparePage from "@/app/(app)/reviews/learned/compare/page";
import FamilyPage from "@/app/(app)/reviews/learned/families/[family]/page";
import LessonPage from "@/app/(app)/reviews/learned/lessons/[id]/page";
import ChallengerPage from "@/app/(app)/reviews/learned/challengers/[id]/page";
import { Notes } from "@/app/(app)/reviews/learned/Notes";
import { FamilyForm } from "@/app/(app)/reviews/learned/FamilyForm";
import { OwnerActions } from "@/app/(app)/reviews/learned/OwnerActions";
import { STAGES } from "@/lib/ui/loaders/knowledgeViews";
import { knowledgeWorld, type KnowledgeWorld } from "./seed";

let current: LoaderEnv;
let role: Who = "owner";
const refresh = vi.fn();
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: current.user.id, role: current.user.role })),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh }),
}));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => current,
}));

let w: KnowledgeWorld;
beforeAll(async () => {
  w = await knowledgeWorld();
});
afterAll(cleanupTempDbs);
afterEach(cleanup);
beforeEach(() => {
  refresh.mockReset();
});

const as = (who: Who) => {
  role = who;
  current = envOf(w, who);
};
const sp = (o: Record<string, string | string[]> = {}) => Promise.resolve(o);
const axeRun = (el: Element) =>
  axe.run(el as HTMLElement, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    rules: { region: { enabled: false } },
  });
const pageOf = {
  index: async () => LearnedPage({ searchParams: sp() }),
  family: async () => FamilyPage({ params: Promise.resolve({ family: "F1" }) }),
  lesson: async () => LessonPage({ params: Promise.resolve({ id: "L-1" }) }),
  challenger: async () => ChallengerPage({ params: Promise.resolve({ id: w.challengerId }) }),
  compare: async () => ComparePage({ searchParams: sp({ ids: [`${w.challengerId},F1.v1`] }) }),
};

describe("index page", () => {
  it("shows search, families, lesson cards, challengers, hypotheses, ledger, plan and documents", async () => {
    as("owner");
    render(await pageOf.index());
    expect(
      screen.getByRole("heading", { level: 1, name: "What the system learned" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search the knowledge" })).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence grade")).toBeInTheDocument();
    expect(screen.getAllByTestId("family-card")).toHaveLength(6);
    const cards = screen.getAllByTestId("lesson-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("L2");
    expect(cards[0]!.textContent).toContain("120");
    for (const h of ["Challengers", "Hypotheses", "Change ledger", "Learning plan", "Documents"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    expect(screen.getAllByText(/Is ZZUP a leader/).length).toBeGreaterThan(0);
  });

  it("only the Owner gets the compare selector", async () => {
    as("owner");
    render(await pageOf.index());
    expect(screen.getByRole("button", { name: "Compare selected" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `Compare ${w.challengerId}` })).toBeInTheDocument();
    cleanup();
    for (const who of ["editor", "viewer"] as const) {
      as(who);
      render(await pageOf.index());
      expect(screen.queryByRole("button", { name: "Compare selected" })).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.getByRole("link", { name: w.challengerId })).toBeInTheDocument();
      cleanup();
    }
  });

  it("filters by grade and by search", async () => {
    as("owner");
    render(await LearnedPage({ searchParams: sp({ grade: "L0" }) }));
    expect(screen.getAllByTestId("lesson-card")).toHaveLength(1);
    cleanup();
    render(await LearnedPage({ searchParams: sp({ q: "zzzz" }) }));
    expect(screen.getByText("No lesson matches this search.")).toBeInTheDocument();
  });

  it("refuses a bad query with not-found", async () => {
    as("owner");
    await expect(LearnedPage({ searchParams: sp({ grade: "L9" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it.each(["editor", "viewer"] as const)(
    "%s: rules only, with no code, name or exact date on any page",
    async (who) => {
      as(who);
      for (const key of Object.keys(pageOf) as (keyof typeof pageOf)[]) {
        const { container } = render(await pageOf[key]());
        const text = container.textContent ?? "";
        expect(findLeaks(text, CODES, NAMES), key).toEqual([]);
        expect(text, key).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(text, key).not.toMatch(/Mon 19 Oct|Mon 05 Oct/);
        cleanup();
      }
    },
  );

  it("says so when your access shows the rules only", async () => {
    as("viewer");
    render(await pageOf.index());
    expect(screen.getByText(/shows the rules only/)).toBeInTheDocument();
    cleanup();
    as("owner");
    render(await pageOf.index());
    expect(screen.queryByText(/shows the rules only/)).toBeNull();
  });

  it("shows the empty state when nothing is known", async () => {
    const { emptyWorld } = await import("../loaders/world");
    const e = await emptyWorld();
    current = envOf(e, "owner");
    render(await pageOf.index());
    expect(screen.getByText("Nothing learned yet")).toBeInTheDocument();
  });
});

describe("lesson, challenger and family pages: Owner-only controls", () => {
  it("lesson: Force apply and Retire for the Owner only; grade wording stays at its grade", async () => {
    as("owner");
    render(await pageOf.lesson());
    const group = screen.getByRole("group", { name: "Owner actions" });
    expect(within(group).getByRole("button", { name: "Force apply" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Retire" })).toBeInTheDocument();
    expect(screen.getByText("Held up in the last third that was kept aside")).toBeInTheDocument();
    cleanup();
    for (const who of ["editor", "viewer"] as const) {
      as(who);
      render(await pageOf.lesson());
      expect(screen.queryByRole("group", { name: "Owner actions" })).toBeNull();
      cleanup();
    }
  });

  it("challenger: Reject and Retire for the Owner only; shadow results Owner only", async () => {
    as("owner");
    render(await pageOf.challenger());
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire" })).toBeInTheDocument();
    expect(screen.getByText("Forward shadow results")).toBeInTheDocument();
    expect(screen.getByText(/Looks fitted to ZZUP/)).toBeInTheDocument();
    cleanup();
    as("editor");
    render(await pageOf.challenger());
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByText("Forward shadow results")).toBeNull();
    expect(screen.queryByText(/Looks fitted/)).toBeNull();
  });

  it("family: roll back and the new-version form for the Owner only", async () => {
    as("owner");
    render(await pageOf.family());
    expect(screen.getAllByTestId("version")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Roll back to F1.v1" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Roll back to ${w.challengerVersion}` }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Create new version" })).toBeInTheDocument();
    cleanup();
    for (const who of ["editor", "viewer"] as const) {
      as(who);
      render(await pageOf.family());
      expect(screen.queryByRole("button", { name: /Roll back/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Create new version" })).toBeNull();
      cleanup();
    }
  });

  it("unknown ids and families are not found", async () => {
    as("owner");
    await expect(LessonPage({ params: Promise.resolve({ id: "L-none" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(ChallengerPage({ params: Promise.resolve({ id: "C-none" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(FamilyPage({ params: Promise.resolve({ family: "F9" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(LessonPage({ params: Promise.resolve({ id: "%E0%A4%A" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("compare page (UXN-201, UXN-208)", () => {
  it("shows 'not yet significant' for an unconfirmed holdout and only real stage names", async () => {
    as("viewer");
    render(await pageOf.compare());
    const items = screen.getAllByTestId("compare-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Not yet significant");
    expect(screen.queryByText(/p\s*[<=]\s*0\.05/)).toBeNull();
    const stage = within(items[0]!).getByText("Stage").nextElementSibling!.textContent!;
    expect(STAGES as readonly string[]).toContain(stage);
    expect(items[1]!.textContent).not.toContain("Stage");
  });

  it("asks for 2 to 5 items otherwise", async () => {
    as("owner");
    render(await ComparePage({ searchParams: sp({ ids: "only-one" }) }));
    expect(screen.getByText("Pick 2 to 5 items")).toBeInTheDocument();
    cleanup();
    render(await ComparePage({ searchParams: sp() }));
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
  });

  it("reports items that do not exist", async () => {
    as("owner");
    render(await ComparePage({ searchParams: sp({ ids: ["F1.v1", "F2.v1", "C-gone"] }) }));
    expect(screen.getByText(/1 of the items you asked for could not be found/)).toBeInTheDocument();
  });
});

describe("notes (UX-071a)", () => {
  it("a Viewer sees 'Note added by <role> on <week>' and cannot write", async () => {
    as("viewer");
    render(await pageOf.lesson());
    expect(screen.getAllByText(/Note added by (owner|editor) on 2026-W43/)).toHaveLength(2);
    expect(screen.queryByText("Agree")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Add a note" })).toBeNull();
  });

  it("an Editor can add a note through the audited annotations route", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Notes kind="lesson" id="L-1" notes={[]} canWrite />);
    fireEvent.change(screen.getByRole("textbox", { name: "Add a note" }), {
      target: { value: "Looks right" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/learning/annotations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      subject_kind: "lesson",
      subject_id: "L-1",
      text: "Looks right",
    });
    vi.unstubAllGlobals();
  });

  it("edit and delete are offered only where the server allows; a failure is shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    const notes = [
      { id: 1, role: "editor", day: "d", text: "mine", edited: true, canChange: true },
      { id: 2, role: "owner", day: "d", text: "theirs", edited: false, canChange: false },
    ];
    render(<Notes kind="hypothesis" id="H-1" notes={notes} canWrite={false} />);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(screen.getByText(/edited/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit note" }), {
      target: { value: "changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not saved");
    vi.unstubAllGlobals();
  });
});

describe("Owner client controls post to the unchanged D-125 routes", () => {
  it("OwnerActions asks twice for a switched-off family", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        calls.push(b);
        return b.confirm_killed
          ? new Response("{}", { status: 200 })
          : new Response(JSON.stringify({ error: "second_confirmation_required", family: "F1" }), {
              status: 409,
            });
      }),
    );
    vi.stubGlobal("confirm", () => true);
    render(
      <OwnerActions
        label="Owner actions"
        buttons={[
          {
            label: "Roll back",
            path: "/api/learning/families/F1/rollback",
            body: { to_version: "F1.v1" },
            prompt: "Sure?",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([
      { to_version: "F1.v1", confirm: true },
      { to_version: "F1.v1", confirm: true, confirm_killed: true },
    ]);
    vi.unstubAllGlobals();
  });

  it("FamilyForm sends only changed numbers", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    render(
      <FamilyForm
        family="F1"
        params={[
          { key: "f1_trail_atr", value: "3", min: 2, max: 4 },
          { key: "f1_max_hold", value: "120", min: 60, max: 120 },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText(/f1 trail atr/), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create new version" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/learning/families/F1/versions");
    expect(JSON.parse(String(init.body))).toEqual({ confirm: true, params: { f1_trail_atr: 2.5 } });
    vi.unstubAllGlobals();
  });
});

describe("accessibility and 360 px", () => {
  it.each(["owner", "editor", "viewer"] as const)(
    "%s: no axe violations on every page",
    async (who) => {
      as(who);
      for (const key of Object.keys(pageOf) as (keyof typeof pageOf)[]) {
        const { container } = render(await pageOf[key]());
        const r = await axeRun(container);
        expect(
          r.violations.map((v) => `${key}: ${v.id}`),
          `${role} ${key}`,
        ).toEqual([]);
        cleanup();
      }
    },
  );

  it("each page's main can shrink and nothing has a fixed pixel width", async () => {
    as("owner");
    for (const key of Object.keys(pageOf) as (keyof typeof pageOf)[]) {
      const { container } = render(await pageOf[key]());
      expect(container.querySelector("main")?.className, key).toContain("min-w-0");
      expect(container.innerHTML, key).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/);
      cleanup();
    }
  });
});
