"use client";
// Offline badge (UXN-010, D-1232, D-1280). Client only: shown while the browser reports no connection and gone
// when it is back. It is separate from the stale-data banner and says plainly that the figures may be old.
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}
const online = () => navigator.onLine;
const serverOnline = () => true;

export function OfflineBadge() {
  const isOnline = useSyncExternalStore(subscribe, online, serverOnline);
  if (isOnline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-20 z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full border border-border bg-surface px-4 py-2 text-center text-sm font-medium text-text shadow-md md:bottom-4"
    >
      Offline: the figures shown may be old. Prices may have moved since you last loaded this page.
    </div>
  );
}
