// Broker links (M21 B1, UXN-317, D-1218). No broker ships with the app: the Owner types up to five address templates
// (validated by `validBrokerTemplate`) and a link is built from a pick or a holding by `fillBrokerTemplate`, which
// substitutes only the URL-encoded `{code}` and `{market}` and appends nothing. This module never calls the network; the
// server never contacts a broker host (a host outside SOURCE_SITES is refused by politeFetch).
import {
  BROKER_LINKS_MAX,
  fillBrokerTemplate,
  validBrokerName,
  validBrokerTemplate,
  type BrokerLink,
} from "@/lib/preferences/brokerTemplate";

export type BrokerHref = { name: string; href: string };

/** The one link of one template for a code, or null when the template is not valid. */
export function brokerUrl(template: string, ctx: { code: string; market: string }): string | null {
  return fillBrokerTemplate(template, ctx.code, ctx.market);
}

/** The links of the Owner's templates for a code (an invalid stored template is left out). */
export function brokerLinksFor(
  links: readonly BrokerLink[],
  ctx: { code: string; market: string },
): BrokerHref[] {
  const out: BrokerHref[] = [];
  for (const l of links) {
    const href = brokerUrl(l.url_template, ctx);
    if (href !== null) out.push({ name: l.name, href });
  }
  return out;
}

export type BrokerForm =
  { ok: true; links: BrokerLink[] } | { ok: false; line: number; reason: string };

/**
 * The rows of the templates form: a row with both fields empty is skipped; a row with one empty, a bad name or a bad
 * template refuses the whole form with its 1-based row and the plain reason (nothing is stored).
 */
export function parseBrokerForm(
  names: readonly string[],
  templates: readonly string[],
): BrokerForm {
  const links: BrokerLink[] = [];
  const n = Math.max(names.length, templates.length);
  for (let i = 0; i < n; i++) {
    const name = (names[i] ?? "").trim();
    const url = (templates[i] ?? "").trim();
    if (name === "" && url === "") continue;
    if (name === "" || url === "")
      return { ok: false, line: i + 1, reason: "Fill in both the name and the address" };
    if (!validBrokerName(name))
      return { ok: false, line: i + 1, reason: "The name must be 1 to 40 characters" };
    const check = validBrokerTemplate(url);
    if (!check.ok) return { ok: false, line: i + 1, reason: check.reason };
    links.push({ name, url_template: url });
  }
  if (links.length > BROKER_LINKS_MAX)
    return { ok: false, line: BROKER_LINKS_MAX + 1, reason: "At most five links" };
  return { ok: true, links };
}
