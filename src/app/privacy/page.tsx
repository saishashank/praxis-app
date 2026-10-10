import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy - Praxis" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-12 leading-relaxed">
      <h1 className="text-2xl font-semibold">Privacy</h1>
      <p className="text-sm text-text-muted">Last updated: 2026-10-09</p>
      <p>
        Praxis is a private, personal-use app. Access is by invitation only, through an allowlist
        kept by the app owner. Nobody else can sign in.
      </p>
      <h2 className="text-lg font-semibold">Sign-in</h2>
      <p>
        You sign in with Google. We ask Google for the scopes openid, email and profile only. We do
        not access your Gmail, contacts, calendar, Drive or anything else in your Google account.
      </p>
      <h2 className="text-lg font-semibold">What we store</h2>
      <ul className="list-disc space-y-1 pl-6">
        <li>Your allowlisted email address and your name.</li>
        <li>Your Google account id (the &quot;sub&quot; value).</li>
        <li>A sign-in audit: the IP address and browser user agent of each sign-in attempt.</li>
      </ul>
      <h2 className="text-lg font-semibold">How long we keep it</h2>
      <p>
        If your access is removed, then 90 days later your email and name are replaced by a hash and
        the IP address and user agent fields in your audit rows are cleared.
      </p>
      <h2 className="text-lg font-semibold">Sharing</h2>
      <p>
        Your data is never sold and never shared for advertising. The app is hosted on Vercel, uses
        Turso for its database and Cloudflare for scheduled jobs, and sends email through Resend.
        These providers process data only to run the app.
      </p>
      <h2 className="text-lg font-semibold">Contact</h2>
      <p>For any privacy question or to ask for removal, contact the app owner directly.</p>
      <p>
        <Link href="/" className="text-accent underline">
          Back to home
        </Link>
      </p>
    </main>
  );
}
