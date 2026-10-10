// Shared fake GitHub for the watchdog tests. No network.
export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const TOKEN = "ghp_FAKEWATCHDOGTOKEN0123456789";

type Dep = { id: number; sha: string; state: string | null };

export function githubMock(deps: Dep[], listStatus = 200) {
  const calls: { url: string; init: { headers: Record<string, string> } }[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname.endsWith("/deployments")) {
      return {
        status: listStatus,
        json: async () =>
          deps.map((d) => ({
            id: d.id,
            sha: d.sha,
            statuses_url: `https://api.github.com/repos/o/r/deployments/${d.id}/statuses`,
          })),
      };
    }
    const id = Number(u.pathname.split("/")[5]);
    const d = deps.find((x) => x.id === id);
    return { status: 200, json: async () => (d?.state ? [{ state: d.state }] : []) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
