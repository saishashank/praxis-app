// A small YAML subset parser (zero dependencies) for the architecture generator (ARC-001).
// Supports what .github/workflows/*.yml and docs/architecture/spec_map.yaml use: block maps and
// sequences, "- key: v" items, quoted and plain scalars, flow lists / maps (also spread over several
// lines), "|" and ">" block scalars, comments. No anchors, tags or multi-document files.

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i += 1;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function plainScalar(s) {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function quoted(t) {
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t.slice(1, -1).replace(/''/g, "'");
}

/** Parse a flow value ("[a, b]", "{a: b}", "x") starting at s[pos]; returns [value, nextPos]. */
function flow(s, pos) {
  let i = pos;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  };
  ws();
  const c = s[i];
  if (c === "[") {
    i += 1;
    const out = [];
    for (;;) {
      ws();
      if (i >= s.length) throw new Error("yaml: unterminated flow collection");
      if (s[i] === "]") return [out, i + 1];
      const [v, n] = flow(s, i);
      out.push(v);
      i = n;
      ws();
      if (s[i] === ",") i += 1;
    }
  }
  if (c === "{") {
    i += 1;
    const out = {};
    for (;;) {
      ws();
      if (i >= s.length) throw new Error("yaml: unterminated flow collection");
      if (s[i] === "}") return [out, i + 1];
      const [k, n] = flowToken(s, i, ":");
      i = n;
      ws();
      if (s[i] === ":") i += 1;
      const [v, m] = flow(s, i);
      out[String(k)] = v;
      i = m;
      ws();
      if (s[i] === ",") i += 1;
    }
  }
  const [v, n] = flowToken(s, i, ",]}");
  return [v, n];
}

function flowToken(s, pos, stops) {
  let i = pos;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i];
    let j = i + 1;
    while (j < s.length && s[j] !== q) j += q === '"' && s[j] === "\\" ? 2 : 1;
    return [quoted(s.slice(i, j + 1)), j + 1];
  }
  let j = i;
  while (j < s.length && !stops.includes(s[j])) j += 1;
  return [plainScalar(s.slice(i, j)), j];
}

function scalar(raw) {
  const t = raw.trim();
  if (t.startsWith("[") || t.startsWith("{")) return flow(t, 0)[0];
  if (t.startsWith('"') || t.startsWith("'")) return quoted(t);
  return plainScalar(t);
}

const KEY_RE =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[{\-&*!|>][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+|$)/;

function splitKey(t) {
  const m = KEY_RE.exec(t);
  if (!m) return null;
  const k = m[1];
  const key = k.startsWith('"') || k.startsWith("'") ? quoted(k) : k;
  return { key, rest: t.slice(m[0].length) };
}

const balanced = (s) => {
  let d = 0;
  let q = null;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") d += 1;
    else if (c === "]" || c === "}") d -= 1;
  }
  return d <= 0;
};

export function parseYaml(text) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((raw) => ({ raw, indent: raw.length - raw.trimStart().length, t: raw.trim() }));
  const n = lines.length;
  let i = 0;
  const skip = () => {
    while (i < n && (lines[i].t === "" || lines[i].t.startsWith("#"))) i += 1;
  };
  const isSeq = (l) => l.t === "-" || l.t.startsWith("- ");

  /** Value text of a line, with multi-line flow collections joined. Advances i past them. */
  function valueText(rest) {
    let v = stripComment(rest);
    while ((v.startsWith("[") || v.startsWith("{")) && !balanced(v) && i < n) {
      v += " " + stripComment(lines[i].t);
      i += 1;
    }
    return v;
  }

  function blockScalar(parentIndent, style) {
    const buf = [];
    let ind = -1;
    while (i < n) {
      const l = lines[i];
      if (l.t === "") {
        buf.push("");
        i += 1;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (ind < 0) ind = l.indent;
      buf.push(l.raw.slice(Math.min(ind, l.indent)));
      i += 1;
    }
    while (buf.length && buf[buf.length - 1] === "") buf.pop();
    return style.startsWith(">") ? buf.join(" ") : buf.join("\n");
  }

  function block(minIndent) {
    skip();
    if (i >= n || lines[i].indent < minIndent) return null;
    return isSeq(lines[i]) ? seq(lines[i].indent) : map(lines[i].indent);
  }

  function seq(ind) {
    const out = [];
    for (;;) {
      skip();
      if (i >= n) break;
      const l = lines[i];
      if (l.indent !== ind || !isSeq(l)) break;
      const rest = l.t === "-" ? "" : l.t.slice(2).trim();
      if (rest === "" || rest.startsWith("#")) {
        i += 1;
        out.push(block(ind + 1));
      } else if (splitKey(rest) && !rest.startsWith("[") && !rest.startsWith("{")) {
        const col = l.raw.indexOf(rest, ind + 1);
        lines[i] = { raw: " ".repeat(col) + rest, indent: col, t: rest };
        out.push(map(col));
      } else {
        i += 1;
        out.push(scalar(valueText(rest)));
      }
    }
    return out;
  }

  function map(ind) {
    const out = {};
    for (;;) {
      skip();
      if (i >= n) break;
      const l = lines[i];
      if (l.indent !== ind || isSeq(l)) break;
      const kv = splitKey(l.t);
      if (!kv) throw new Error(`yaml: cannot read line ${i + 1}: ${l.t.slice(0, 40)}`);
      i += 1;
      const rest = stripComment(kv.rest).trim();
      if (rest === "") {
        skip();
        if (i < n && lines[i].indent > ind) out[kv.key] = block(ind + 1);
        else if (i < n && lines[i].indent === ind && isSeq(lines[i])) out[kv.key] = seq(ind);
        else out[kv.key] = null;
      } else if (/^[|>][+-]?$/.test(rest)) {
        out[kv.key] = blockScalar(ind, rest);
      } else {
        out[kv.key] = scalar(valueText(kv.rest));
      }
    }
    return out;
  }

  const result = block(0);
  skip();
  if (i < n) throw new Error(`yaml: unexpected content at line ${i + 1}`);
  return result;
}
