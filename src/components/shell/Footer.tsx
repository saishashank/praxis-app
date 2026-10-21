// Footer of every signed-in page (ROL-106, NFR-031): the simulation disclaimer, the "Simulated"
// explainer link (UX-002), Privacy and Terms.
import Link from "next/link";
import { GLOSSARY_HREF } from "@/lib/ui/nav";

export const DISCLAIMER = "Simulation for personal information only — not financial advice";

export function Footer() {
  return (
    <footer className="mx-auto mt-8 w-full max-w-[1200px] px-4 pb-6 text-xs text-text-muted">
      <p className="m-0">{DISCLAIMER}</p>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        <li>
          <Link
            href={`${GLOSSARY_HREF}#simulated`}
            className="inline-flex min-h-6 items-center underline"
          >
            What does simulated mean?
          </Link>
        </li>
        <li>
          <Link href="/privacy" className="inline-flex min-h-6 items-center underline">
            Privacy
          </Link>
        </li>
        <li>
          <Link href="/terms" className="inline-flex min-h-6 items-center underline">
            Terms
          </Link>
        </li>
      </ul>
    </footer>
  );
}
