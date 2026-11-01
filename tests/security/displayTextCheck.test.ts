// @vitest-environment node
// SEC-016 (V1-S14, D-724): the deterministic display-text check (no model call) on LLM text and
// third-party headlines: URLs, domains, e-mail addresses and credential / account-action phrases
// are replaced; ordinary market language is untouched.
import { describe, expect, it } from "vitest";
import {
  displayText,
  displayTextProblem,
  displayTitle,
  TITLE_WITHHELD,
} from "@/lib/view/displayText";

describe("fails", () => {
  it.each([
    ["Visit praxis-login.example to re-verify", "domain"],
    ["See https://evil.test/login now", "url"],
    ["Go to www.bhp-update.com", "url"],
    ["Update at hxxp-free.net/path", "domain"],
    ["Contact support@praxis-help.example", "email"],
    ["write to ceo @ firm.com.au", "email"],
    ["javascript:alert(1)", "url"],
    ["Please sign in to continue", "phrase"],
    ["Log in again to keep access", "phrase"],
    ["Verify your account today", "phrase"],
    ["Rotate your API key immediately", "phrase"],
    ["Enter your key below", "phrase"],
    ["Your token has expired", "phrase"],
    ["Reset your password", "phrase"],
    ["Share the API token with us", "phrase"],
    ["Click here for details", "phrase"],
  ])("%s", (text, reason) => {
    expect(displayTextProblem(text)).toBe(reason);
    expect(displayTitle(text)).toBe(TITLE_WITHHELD);
    expect(displayText(text, "rules-only")).toBe("rules-only");
  });
});

describe("passes", () => {
  it.each([
    "Sell-off deepens as miners fall 4.5%",
    "BHP Group Ltd (ASX:BHP) trading halt",
    "Quarterly activities report Q1.2 FY26",
    "Annual General Meeting - Notice of Meeting and Proxy Form",
    "Appendix 3Y - Change of Director's Interest Notice",
    "Investors should buy the dip say analysts, though risks remain",
    "Rio Tinto raises iron ore guidance to 1.5 Mt",
    "Commonwealth Bank signed a contract with Telstra Corp. Ltd.",
    "",
  ])("%s", (text) => {
    expect(displayTextProblem(text)).toBeNull();
    expect(displayTitle(text)).toBe(text);
  });
});

describe("evasions", () => {
  it("full-width characters are normalised before the check", () => {
    expect(displayTextProblem("ｖｉｓｉｔ ｅｖｉｌ．ｃｏｍ")).not.toBeNull();
  });
});
