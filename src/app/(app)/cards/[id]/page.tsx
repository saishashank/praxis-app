// Decision Card page: a direct link, a reload or a new tab. Opened from inside the app the same body
// shows as a popup instead (src/app/(app)/@modal/(.)cards/[id], D-884). See CardView.tsx.
import { requireUser } from "@/lib/auth/guard";
import { cardBody, decodeCardId } from "./CardView";

export const dynamic = "force-dynamic";

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = decodeCardId(raw);
  const user = await requireUser("read", `/cards/${encodeURIComponent(id)}`);
  return (
    <main className="mx-auto flex max-w-3xl min-w-0 flex-col gap-6 px-4 py-6">
      {await cardBody(user, id)}
    </main>
  );
}
