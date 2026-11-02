// SEC-016 deterministic display-text check (no model call). Every LLM text and every third-party
// headline or title shown to a person passes it. Text containing a URL, a domain, an e-mail address
// or a credential / account-action phrase aimed at the reader is replaced, never edited, so a crafted
// headline ("Visit praxis-login.example to re-verify") cannot reach a screen or an e-mail.
// Ordinary market imperatives ("sell-off deepens", "sign a contract") stay allowed.

export const TITLE_WITHHELD = "[title withheld — see source]";
export const TEXT_WITHHELD = "[text withheld — see source]";

const TLDS =
  "com|net|org|io|co|au|nz|uk|us|info|biz|xyz|top|app|dev|ai|gov|edu|me|cc|tv|ly|online|site|live|club|shop|store|cloud|link|click|example|test|invalid|localhost|ru|cn|tk|ml|ga|cf|gq|ws|to|sh|gl|gd";

const URL_RE = /\b(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.)\S+/i;
const SCHEME_RE = /\b(?:https?|ftp|javascript|data|mailto):/i;
const EMAIL_RE = /[a-z0-9._%+-]+\s?@\s?[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const DOMAIN_RE = new RegExp(
  String.raw`(?:^|[^a-z0-9@-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:${TLDS})(?![a-z0-9-])`,
  "i",
);

// Credential and account-action phrases aimed at the reader.
const PHRASES: RegExp[] = [
  /\bsign[\s-]?in\b/i,
  /\blog[\s-]?in\b/i,
  /\bverify\s+(?:your|the)\s+(?:account|identity|login|email|e-mail|details)\b/i,
  /\bre-?verify\b/i,
  /\b(?:confirm|update|reset)\s+your\s+(?:account|password|details|credentials|login)\b/i,
  /\b(?:rotate|enter|share|send|paste|provide|reveal)\s+(?:your|the)\s+(?:\w+\s+){0,2}(?:key|keys|token|password|passphrase|secret|credentials|code)\b/i,
  /\bpasswords?\b/i,
  /\bpassphrase\b/i,
  /\byour\s+(?:\w+\s+)?(?:token|api\s*key|secret|credentials|account\s+(?:is|has|will|number))\b/i,
  /\bapi[\s-]?(?:token|key)s?\b/i,
  /\bone[\s-]?time\s+(?:code|passcode)\b/i,
  /\bclick\s+(?:here|the\s+link|below)\b/i,
];

export type DisplayTextReason = "url" | "email" | "domain" | "phrase";

/** Why the text fails the check, or null when it is fine to display. */
export function displayTextProblem(s: string): DisplayTextReason | null {
  const t = s.normalize("NFKC");
  if (URL_RE.test(t) || SCHEME_RE.test(t)) return "url";
  if (EMAIL_RE.test(t)) return "email";
  if (DOMAIN_RE.test(t)) return "domain";
  if (PHRASES.some((p) => p.test(t))) return "phrase";
  return null;
}

export const passesDisplayText = (s: string): boolean => displayTextProblem(s) === null;

/** Text that fails is replaced by `fallback` (the rules-only text); text that passes is returned unchanged. */
export function displayText(s: string, fallback: string = TEXT_WITHHELD): string {
  return passesDisplayText(s) ? s : fallback;
}

/** Third-party headline or title (SEC-016: "[title withheld — see source]"). */
export const displayTitle = (s: string): string => displayText(s, TITLE_WITHHELD);
