"use server";
// Home welcome banner dismissal (UX-012a, M7 T11). The dismissal is a per-user, per-device cookie:
// no database write, no audit event, nothing secret in it. requireUser("read") first.
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth/guard";
import { welcomeCookieName } from "./welcome";

const YEAR_SECONDS = 31_536_000; // threshold-ok: one year in seconds

export async function dismissWelcomeAction(): Promise<void> {
  const user = await requireUser("read", "/");
  (await cookies()).set(welcomeCookieName(user.id), "1", {
    path: "/",
    maxAge: YEAR_SECONDS,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
  revalidatePath("/");
}
