// Role matrix (ROL-102a). Server-enforced; anything not listed is Owner-only.
export type Role = "owner" | "editor" | "viewer";
export const ROLES: readonly Role[] = ["owner", "editor", "viewer"];

export type Action =
  | "read" // pages other than Usage/Admin/Ops/logs
  | "own_preferences" // own user_preference + own alert ack
  | "annotate"
  | "what_if"
  | "unmask"
  | "admin"; // users, markets, sources, config, review queue, rules, challengers, kill switches, secrets status, Usage, Ops, logs

const MATRIX: Record<Action, readonly Role[]> = {
  read: ["owner", "editor", "viewer"],
  own_preferences: ["owner", "editor", "viewer"],
  annotate: ["owner", "editor"],
  what_if: ["owner", "editor"],
  unmask: ["owner"],
  admin: ["owner"],
};

export function can(role: Role | null | undefined, action: string): boolean {
  if (role !== "owner" && role !== "editor" && role !== "viewer") return false;
  const allowed = Object.hasOwn(MATRIX, action) ? MATRIX[action as Action] : ["owner"];
  return allowed.includes(role);
}
