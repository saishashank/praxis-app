// The fetch of the clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.1, §4). The Worker runners are reused
// unchanged, so they still "dispatch a GitHub workflow" with `fetch`. This shim sits between them and the
// network:
//  - POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/<file>/dispatches is turned into a
//    local job (the caller's `enqueue`) and answered 204 like GitHub; a workflow in `passthrough` (replay.yml,
//    INF-O5) goes to the real GitHub API with the real token; a workflow that is not in the manifest gets 404.
//  - The Worker runners only accept https (or libsql) origins, but inside the Docker network the app and the
//    database are plain http (`http://web:3000`, `http://main.sqld:8080`). `origins` maps the https stand-in
//    origin the runners were given to the real http origin; path, query, headers and body are untouched.
//  - Everything else (GitHub reads, other calls) passes through.
// The shim never logs a header or a body.
export type EnqueueResult = "queued" | "duplicate" | "unknown-job";
export type Dispatch = { workflow: string; ref: string; inputs: Record<string, string> };

export type ShimOptions = {
  realFetch: typeof fetch;
  /** Starts (queues) the local job of a workflow file; "unknown-job" when the manifest has none. */
  enqueue: (d: Dispatch) => EnqueueResult;
  /** Workflow files that go to GitHub for real. */
  passthrough: readonly string[];
  /** Stand-in https origin -> real origin, e.g. {"https://web.praxis.internal": "http://web:3000"}. */
  origins?: Readonly<Record<string, string>>;
  /** One short line per intercepted dispatch (no secrets). */
  log?: (line: string) => void;
};

const DISPATCH_RE =
  /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/workflows\/([A-Za-z0-9._-]+\.yml)\/dispatches$/;

/** The URL with its origin swapped per `origins`, or null when the origin is not mapped. */
export function originMapped(
  url: string,
  origins: Readonly<Record<string, string>>,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const target = origins[u.origin];
  return target === undefined ? null : `${target.replace(/\/+$/, "")}${u.pathname}${u.search}`;
}

export function makeClockFetch(o: ShimOptions): typeof fetch {
  const origins = o.origins ?? {};
  const shim = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const m = DISPATCH_RE.exec(url);
    if (m && method === "POST") {
      const workflow = m[1]!;
      if (o.passthrough.includes(workflow)) return o.realFetch(input, init);
      let body: { ref?: unknown; inputs?: unknown } = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as typeof body;
      } catch {
        return new Response(JSON.stringify({ message: "Problems parsing JSON" }), { status: 400 });
      }
      const inputs: Record<string, string> = {};
      if (body.inputs && typeof body.inputs === "object") {
        for (const [k, val] of Object.entries(body.inputs as Record<string, unknown>)) {
          inputs[k] = String(val);
        }
      }
      const res = o.enqueue({
        workflow,
        ref: typeof body.ref === "string" ? body.ref : "",
        inputs,
      });
      o.log?.(`clock: dispatch ${workflow} -> local job (${res})`);
      return res === "unknown-job"
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(null, { status: 204 });
    }
    const real = originMapped(url, origins);
    return real === null ? o.realFetch(input, init) : o.realFetch(real, init);
  };
  return shim as typeof fetch;
}
