// Empty state of the Picks area (UXR-007, UXR-055): the shared EmptyState with the picks illustration in
// the Picks section colour, one sentence. Decorative art only.
import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/States";

export function PicksEmptyArt({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div data-testid="picks-empty" className="min-w-0">
      <EmptyState title={title} action={action} motif="picks" hue="picks">
        {children}
      </EmptyState>
    </div>
  );
}
