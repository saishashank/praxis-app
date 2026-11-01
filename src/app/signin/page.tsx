import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { signInAction } from "@/lib/auth/actions";
import { safeCallbackUrl } from "@/lib/auth/callbackUrl";

export const metadata: Metadata = { title: "Sign in - Praxis" };

type Props = { searchParams: Promise<{ callbackUrl?: string; error?: string }> };

export default async function SignInPage({ searchParams }: Props) {
  const sp = await searchParams;
  const callbackUrl = safeCallbackUrl(sp.callbackUrl);
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="sr-only">Sign in</h1>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/praxis-logo-tagline-light.svg"
        alt="Praxis — Learn. Earn. Repeat."
        width={240}
        className="logo-light h-auto"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/praxis-logo-tagline-dark.svg"
        alt="Praxis — Learn. Earn. Repeat."
        width={240}
        className="logo-dark h-auto"
      />
      <p className="m-0 text-sm text-text">
        Praxis is a personal stock-learning simulator: it picks, tracks and reviews paper trades,
        with no real money.
      </p>
      {sp.error ? (
        <p role="alert" className="text-sm">
          This account is not authorised.
        </p>
      ) : null}
      <form action={signInAction}>
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <button type="submit" className={buttonClass("default", "min-h-11 px-6")}>
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
