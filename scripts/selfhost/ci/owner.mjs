// Branch CI only (selfhost-check.yml, switch drill): print clock_owner of a database, `absent` when the key is not
// there. Node builtins only, so it runs in the jobs image with a bind mount. The token, when the database checks
// one, comes in the environment (OWNER_TOKEN), never as an argument.
//   node owner.mjs <base-url>      e.g. http://main.sqld:8080 or http://fake-turso:8080
const base = process.argv[2];
const token = process.env.OWNER_TOKEN;
if (!/^http:\/\/[^\s/]+$/.test(base ?? "")) {
  console.log("usage: owner.mjs <http://host:port>");
  process.exit(2);
}
const res = await fetch(`${base}/v2/pipeline`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: { sql: "SELECT value_json FROM worker_state WHERE key = 'clock_owner'" },
      },
      { type: "close" },
    ],
  }),
  signal: AbortSignal.timeout(15_000),
});
if (res.status !== 200) {
  console.log(`error HTTP ${res.status}`);
  process.exit(1);
}
const rows = (await res.json()).results?.[0]?.response?.result?.rows ?? [];
console.log(rows.length === 0 ? "absent" : JSON.parse(rows[0][0].value));
