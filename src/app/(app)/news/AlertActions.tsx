"use client";
// Acknowledge / snooze buttons of one alert (UXN-157, UXN-160). The buttons are only needed once the
// page is interactive, so the implementation (AlertActionsPanel.tsx) is a separate lazy chunk and stays
// out of the News first-load JS (UX-005 budget). It still renders on the server.
import { lazy, Suspense, type ComponentProps } from "react";

const Panel = lazy(() =>
  import("./AlertActionsPanel").then((m) => ({ default: m.AlertActionsPanel })),
);

export function AlertActions(props: ComponentProps<typeof Panel>) {
  return (
    <Suspense fallback={null}>
      <Panel {...props} />
    </Suspense>
  );
}
