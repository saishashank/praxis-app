// Steelman slot of the Decision Card (V2 ch. 07, UXR-024): the strongest case against the card. It
// renders only when text exists, so there is never an empty heading.
import { Card } from "@/components/ui/Card";

export function Steelman({ data }: { data: { text: string } | null }) {
  if (data === null || data.text.trim() === "") return null;
  return (
    <Card title="The case against" data-testid="steelman">
      <p className="m-0 text-sm">{data.text}</p>
    </Card>
  );
}
