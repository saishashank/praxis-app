"use client";
// Settings › About install row (M21 P1, PLT-079, D-1231). When the browser offers its install prompt the row is
// one button that opens it; otherwise it says where the browser keeps its own install command. No notification
// permission is ever requested (D-1280).
import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: string }>;
};

export function InstallRow() {
  const [offer, setOffer] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setOffer(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setOffer(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const row =
    "flex min-h-14 w-full items-center gap-3 border-b border-border px-1 py-2 text-sm text-text";
  return (
    <div className={row}>
      <span className="min-w-0 flex-1 break-words">Install Praxis on this device</span>
      {offer ? (
        <button
          type="button"
          onClick={() => {
            void offer.prompt().catch(() => undefined);
            setOffer(null);
          }}
          className={cn(
            "ui-btn-secondary min-h-11 rounded-md border border-border px-4 text-sm font-semibold",
          )}
        >
          Install
        </button>
      ) : (
        <span className="max-w-[55%] text-right font-medium break-words">
          {installed ? "Installed" : "Use your browser menu: Install app or Add to Home Screen"}
        </span>
      )}
    </div>
  );
}
