// A small JSON-schema subset (LLM-071, D-244), written in-house so no dependency is added. It is used
// two ways: app-side validation of every model answer (always), and, where the roster says the model
// supports it, the same schema is sent to the provider in its strict mode. Supported keywords: type,
// properties, required, enum, items, minItems, maxLength, additionalProperties (false only).

export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export type JsonSchema = {
  type: SchemaType;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  enum?: readonly (string | number | boolean | null)[];
  items?: JsonSchema;
  minItems?: number;
  maxLength?: number;
  additionalProperties?: false;
};

export type SchemaResult = { ok: true } | { ok: false; field: string; reason: string };

const ROOT = "$";

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function typeOk(type: SchemaType, v: unknown): boolean {
  switch (type) {
    case "object":
      return isObj(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
  }
}

function check(schema: JsonSchema, v: unknown, path: string): SchemaResult {
  const bad = (reason: string): SchemaResult => ({ ok: false, field: path, reason });
  if (!typeOk(schema.type, v)) return bad(`expected ${schema.type}`);
  if (schema.enum !== undefined && !schema.enum.some((e) => e === v)) return bad("not in enum");
  if (typeof v === "string" && schema.maxLength !== undefined && v.length > schema.maxLength)
    return bad("too long");
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) return bad("too few items");
    if (schema.items) {
      for (let i = 0; i < v.length; i += 1) {
        const r = check(schema.items, v[i], `${path}[${i}]`);
        if (!r.ok) return r;
      }
    }
  }
  if (isObj(v)) {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(v, k) || v[k] === undefined)
        return { ok: false, field: path === ROOT ? k : `${path}.${k}`, reason: "missing" };
    }
    for (const k of Object.keys(v).sort()) {
      const sub = path === ROOT ? k : `${path}.${k}`;
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        const r = check(props[k], v[k], sub);
        if (!r.ok) return r;
      } else if (schema.additionalProperties === false) {
        return { ok: false, field: sub, reason: "unexpected property" };
      }
    }
  }
  return { ok: true };
}

/** First failure in a fixed order (required keys, then properties by name), so the field is stable. */
export function validate(schema: JsonSchema, value: unknown): SchemaResult {
  return check(schema, value, ROOT);
}

/**
 * Makes the evidence-ID citations a per-request enum: every array property called `key` (default
 * "citations") gets string items restricted to `ids`. Returns a new schema; the input is not changed.
 */
export function withCitationEnum(
  schema: JsonSchema,
  ids: readonly string[],
  key = "citations",
): JsonSchema {
  const sorted = [...new Set(ids)].sort();
  const walk = (s: JsonSchema, named: boolean): JsonSchema => {
    let out: JsonSchema = s;
    if (named && s.type === "array") out = { ...s, items: { type: "string", enum: sorted } };
    else if (s.items) out = { ...s, items: walk(s.items, false) };
    if (s.properties) {
      const props: Record<string, JsonSchema> = {};
      for (const k of Object.keys(s.properties).sort()) props[k] = walk(s.properties[k], k === key);
      out = { ...out, properties: props };
    }
    return out;
  };
  return walk(schema, false);
}

export type SchemaDialect = "groq-strict" | "gemini";

/**
 * The provider-facing copy of a schema. Keywords a provider's schema mode does not accept are stripped
 * (the app validates them anyway). Groq strict mode needs every property required and no extras.
 */
export function toProviderSchema(schema: JsonSchema, dialect: SchemaDialect): JsonSchema {
  const walk = (s: JsonSchema): JsonSchema => {
    const out: JsonSchema = { type: s.type };
    if (s.enum !== undefined) out.enum = s.enum;
    if (s.items) out.items = walk(s.items);
    if (s.properties) {
      const props: Record<string, JsonSchema> = {};
      for (const k of Object.keys(s.properties).sort()) props[k] = walk(s.properties[k]);
      out.properties = props;
      if (dialect === "groq-strict") {
        out.required = Object.keys(props);
        out.additionalProperties = false;
      } else if (s.required) {
        out.required = s.required;
      }
    }
    return out;
  };
  return walk(schema);
}
