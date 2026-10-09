import { describe, expect, it } from "vitest";
import { can, type Action, type Role } from "@/lib/auth/permissions";

// ROL-102a: [action, owner, editor, viewer]
const TABLE: Array<[Action, boolean, boolean, boolean]> = [
  ["read", true, true, true],
  ["own_preferences", true, true, true],
  ["annotate", true, true, false],
  ["what_if", true, true, false],
  ["unmask", true, false, false],
  ["admin", true, false, false],
];

describe("can", () => {
  it.each(TABLE)("%s", (action, o, e, v) => {
    expect(can("owner", action)).toBe(o);
    expect(can("editor", action)).toBe(e);
    expect(can("viewer", action)).toBe(v);
    expect(can(null, action)).toBe(false);
    expect(can(undefined, action)).toBe(false);
  });

  it("unknown action is Owner-only", () => {
    expect(can("owner", "launch_missiles")).toBe(true);
    expect(can("editor", "launch_missiles")).toBe(false);
    expect(can("viewer", "launch_missiles")).toBe(false);
    expect(can("owner", "toString")).toBe(true); // prototype keys are not actions
    expect(can("editor", "__proto__")).toBe(false);
  });

  it("unknown role is refused", () => {
    expect(can("root" as Role, "read")).toBe(false);
  });
});
