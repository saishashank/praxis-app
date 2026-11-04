// D-884 ("the Decision Card can be a popup: I want to stay on the screen, Strategies is my main
// focus"): a card link followed inside the app opens the card over the current page. Closing it
// goes back to that page. A direct link or a reload renders the full page (cards/[id]/page.tsx).
// The same guard and body as the page.
import { requireUser } from "@/lib/auth/guard";
import { cardBody, decodeCardId } from "../../../cards/[id]/CardView";
import { CardModal } from "./CardModal";

export const dynamic = "force-dynamic";

export default async function CardPopup({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = decodeCardId(raw);
  const user = await requireUser("read", `/cards/${encodeURIComponent(id)}`);
  return <CardModal>{await cardBody(user, id)}</CardModal>;
}
