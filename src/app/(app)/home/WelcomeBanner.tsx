// Welcome banner (UX-012a): shown until dismissed. Server component; the dismiss button is a form that
// calls a server action, so it works without client JavaScript.
import { InfoIcon } from "@/components/ui/icons";
import { SimulatedLabel } from "@/components/ui/Values";
import { buttonClass } from "@/components/ui/Button";
import { dismissWelcomeAction } from "./actions";

export function WelcomeBanner() {
  return (
    <section
      aria-labelledby="welcome-title"
      className="min-w-0 break-words rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start gap-2">
        <InfoIcon className="mt-1 shrink-0" />
        <div className="min-w-0">
          <h2 id="welcome-title" className="text-base font-semibold">
            Welcome to Praxis
          </h2>
          <p className="mt-1 text-sm">
            Twelve practice strategies each start with A$600 of pretend money. A strategy reaches
            its goal at A$1,200 and stops at its loss limit of A$300. Nothing here is real money and
            nothing can place an order.
          </p>
          <p className="mt-2 text-sm">
            <strong>Simulated</strong> means every trade and every amount is a calculation on past
            and end-of-day prices, not a trade in a market. <SimulatedLabel />
          </p>
          <form action={dismissWelcomeAction} className="mt-3">
            <button type="submit" className={buttonClass("secondary")}>
              Got it, hide this
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
