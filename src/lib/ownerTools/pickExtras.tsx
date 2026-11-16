// What the Owner sees added to a pick tile while the tools are on (M21 B1, UXN-314, UXN-317, D-1216, D-1219): the tier
// word and the broker links. Loaded by the Picks page through a dynamic import behind the hidden-route predicate, and
// passed to the tile as its `extra` slot, so no pick surface imports this section statically. A second check here
// (`ownerTools`, the one reader of the Owner's templates) returns nothing for anyone but the pinned Owner with the switch on.
import type { ReactNode } from "react";
import { BrokerLinks } from "@/components/ownerTools/BrokerLinks";
import { TierLabel } from "@/components/ownerTools/TierLabel";
import type { CurrentUser } from "@/lib/auth/session";
import { authDb, mainDb } from "@/lib/db/client";
import { ownerTools } from "@/lib/preferences/ownerTools";
import { brokerLinksFor } from "./brokerLinks";

export async function pickExtras(args: {
  user: CurrentUser;
  market: string;
  profile: string;
  picks: ReadonlyArray<{ id: string; code: string }>;
}): Promise<Map<string, ReactNode>> {
  const out = new Map<string, ReactNode>();
  const owner = await ownerTools({ auth: authDb(), main: mainDb() }, args.user, process.env);
  if (owner === null) return out;
  for (const p of args.picks) {
    out.set(
      p.id,
      <div data-testid="owner-pick-extra" className="mt-3 flex flex-wrap items-center gap-3">
        <TierLabel profile={args.profile} />
        <BrokerLinks
          links={brokerLinksFor(owner.broker_links, { code: p.code, market: args.market })}
        />
      </div>,
    );
  }
  return out;
}
