// Family badge with its "i" sheet (UXN-311, UXR-052): plain-words label in the family colour, and a
// Sheet that explains the family. The text is the Strategies-tab phrase table (no LLM wording). The
// badge is not masked for any role (ROL-107): it carries no code, name or price.
import Link from "next/link";
import type { PickRowView } from "@/lib/ui/loaders/picks";
import { FamilyBadge } from "@/components/ui/Family";
import { InfoIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import { FAMILY_BADGES } from "./text";

export function PickFamily({
  pick,
}: {
  pick: Pick<PickRowView, "family" | "familyName" | "familyInfo">;
}) {
  const b = FAMILY_BADGES[pick.family];
  if (!b) return <span className="text-sm text-text-muted">{pick.familyName}</span>;
  const info = pick.familyInfo;
  return (
    <FamilyBadge
      code={b.code}
      label={b.label}
      info={
        <Sheet
          title={`${b.label}: how this strategy works`}
          description={pick.familyName}
          href="/strategies"
          triggerClassName="inline-flex size-8 items-center justify-center rounded-full text-[var(--h-text)]"
          trigger={
            <>
              <InfoIcon aria-hidden="true" />
              <span className="sr-only">{`About ${b.label}`}</span>
            </>
          }
        >
          <div data-testid="family-sheet" className="flex flex-col gap-3 text-sm">
            <p className="m-0">{info?.oneLiner ?? "No description is stored for this strategy."}</p>
            {info ? (
              <dl className="m-0 flex flex-col gap-2">
                <div>
                  <dt className="font-semibold">Buys when</dt>
                  <dd className="m-0 text-text-muted">{info.buys}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Sells when</dt>
                  <dd className="m-0 text-text-muted">{info.sells}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Works best when</dt>
                  <dd className="m-0 text-text-muted">{info.worksBest}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Usually breaks when</dt>
                  <dd className="m-0 text-text-muted">{info.mainRisk}</dd>
                </div>
              </dl>
            ) : null}
            <Link href="/strategies" className="text-accent underline">
              See it on the Strategies tab
            </Link>
          </div>
        </Sheet>
      }
    />
  );
}
