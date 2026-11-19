// The Owner tools' layout (M21 B1, D-1214). It renders its children and nothing else: no heading, link or text of its own,
// so a request the page guard turns away (the proxy already answers it as a missing route) shows nothing of the section.
// The menu is drawn by each page after its guard (OwnerToolsNav). B2 adds /trades under this layout.
import type { ReactNode } from "react";

export default function OwnerToolsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
