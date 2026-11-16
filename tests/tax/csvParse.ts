// A small RFC 4180 reader for the tax CSV tests, and the inverse of the formula guard (a leading single quote that guards a
// =, +, -, @, tab or carriage-return cell is removed). Test support only.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export const unguard = (c: string): string =>
  c.length > 1 && c[0] === "'" && "=+-@\t\r".includes(c[1]!) ? c.slice(1) : c;

/** Exact decimal text with six places back to micro units. */
export function microFromText(t: string): bigint {
  const neg = t.startsWith("-");
  const [w, f] = (neg ? t.slice(1) : t).split(".");
  const v = BigInt(w!) * 1_000_000n + BigInt(f ?? "0");
  return neg ? -v : v;
}
