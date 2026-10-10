import type { Metadata } from "next";
import Link from "next/link";
import { signInAction } from "@/lib/auth/actions";
import { safeCallbackUrl } from "@/lib/auth/callbackUrl";

export const metadata: Metadata = { title: "Sign in - Praxis" };

type Props = { searchParams: Promise<{ callbackUrl?: string; error?: string }> };

export default async function SignInPage({ searchParams }: Props) {
  const sp = await searchParams;
  const callbackUrl = safeCallbackUrl(sp.callbackUrl);
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-6 px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/praxis-logo-light.svg"
        alt="Praxis logo"
        width={200}
        className="logo-light h-auto"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/praxis-logo-dark.svg"
        alt="Praxis logo"
        width={200}
        className="logo-dark h-auto"
      />
      {sp.error ? (
        <p role="alert" className="text-sm">
          This account is not authorised.
        </p>
      ) : null}
      <form action={signInAction}>
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <button type="submit" className="rounded border border-current px-4 py-2">
          Sign in with Google
        </button>
      </form>
      <nav className="flex gap-6 text-sm">
        <Link href="/privacy" className="text-accent underline">
          Privacy
        </Link>
        <Link href="/terms" className="text-accent underline">
          Terms
        </Link>
      </nav>
    </main>
  );
}
