"use server";
// Server actions for sign-in / sign-out. Sign-out is POST-only (SEC-011) and audit-logged.
import { headers } from "next/headers";
import { signIn, signOut } from "@/auth";
import { authDb } from "@/lib/db/client";
import { audit, requestMeta } from "./audit";
import { safeCallbackUrl } from "./callbackUrl";
import { getCurrentUser } from "./session";

export async function signInAction(formData: FormData): Promise<void> {
  const redirectTo = safeCallbackUrl(formData.get("callbackUrl"));
  await signIn("google", { redirectTo });
}

export async function signOutAction(): Promise<void> {
  const user = await getCurrentUser();
  if (user) {
    await audit(authDb(), process.env, requestMeta(await headers()), {
      actorUserId: user.id,
      action: "auth.signout",
      targetType: "app_user",
      targetId: String(user.id),
    });
  }
  await signOut({ redirectTo: "/signin" });
}
