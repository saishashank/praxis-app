// Minimal, non-informative liveness response (PLT-031). Nothing about the system is revealed.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
