// Break-glass alert (ROL-101a): email to the Owner via Resend. Never throws; returns success.
import { norm, type AuthEnv } from "./env";

export async function sendRecoveryAlert(
  env: AuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const to = norm(env.OWNER_EMAIL);
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Praxis <onboarding@resend.dev>",
        to: [to],
        subject: "[Praxis] Recovery sign-in used",
        text: "The break-glass recovery address was just used to sign in as Owner. If this was not you, disable recovery and rotate secrets now.",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
