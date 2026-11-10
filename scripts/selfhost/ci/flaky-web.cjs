// Branch CI only: a stand-in "new web" that PASSES the pre-deploy check but is UNHEALTHY in production, to prove the
// automatic revert of `praxis deploy`. The check stack starts web with NODE_OPTIONS=--max-old-space-size=768 and the
// production stack with 1152 (docker-compose.check.yml / docker-compose.prod.yml): this server is healthy only when
// it sees 768. It answers what scripts/selfhost/smoke.mjs asks of an anonymous visitor.
const http = require("node:http");
const healthy = /768/.test(process.env.NODE_OPTIONS || "");
http
  .createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    if (p === "/api/health") {
      res.statusCode = healthy ? 200 : 503;
      return res.end(healthy ? "ok" : "unhealthy");
    }
    if (p === "/signin") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end("<!doctype html><title>Sign in</title><h1>Sign in</h1>");
    }
    res.statusCode = 307;
    res.setHeader("location", "/signin?callbackUrl=" + encodeURIComponent(p));
    return res.end();
  })
  .listen(3000, "0.0.0.0");
