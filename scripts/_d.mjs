import fs from "node:fs";
let s = fs.readFileSync("docs/M20_design.md", "utf8");
const i = s.indexOf("- **D-1157**");
const j = s.indexOf("\n", i);
const add =
  "- **D-1158** Band lock has no clock (IN1, Fable review, D-1109, D-1163, D-1169): an exit on a code stuck at its LOWER circuit waits indefinitely at the locked mark, because the wait rule has no session counter (a halt has one: the declining suspension mark of ARN-026 after 20 sessions). Recorded, no code change at M20. Recommended follow-up: a `band_lock_sessions` counter per code feeding the halt mark, so a long lock marks down like a suspension; the by-side refinement of D-1169 belongs with it.";
s = s.slice(0, j + 1) + add + "\n" + s.slice(j + 1);
fs.writeFileSync("docs/M20_design.md", s);
