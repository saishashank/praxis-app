"use client";
// The only client island of the Control Room: boot sequence (once per session, any key or tap skips
// it), the 60 s refresh while the page is visible (decision 24), opening a part's details from a ring
// link, Focus mode (full screen) and "Read aloud" with the browser's own speech (no paid service, no
// microphone). It receives plain props and server-rendered children only; no server imports.
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import styles from "./ControlRoom.module.css";

export const REFRESH_MS = 60_000; // threshold-ok: UXN-283, values refresh every 60 s
export const BOOT_MS = 1_100; // threshold-ok: UXN-285 a, boot <= 1.2 s
const BOOT_KEY = "praxis.controlroom.booted";

function seenBoot(): boolean {
  try {
    return window.sessionStorage.getItem(BOOT_KEY) === "1";
  } catch {
    return false;
  }
}
const noopSubscribe = (): (() => void) => () => {};
const hasSpeech = (): boolean => typeof window !== "undefined" && "speechSynthesis" in window;

function markBoot(): void {
  try {
    window.sessionStorage.setItem(BOOT_KEY, "1");
  } catch {
    /* storage can be blocked; the intro then plays again, which is harmless */
  }
}

/** Refreshes the server data every `ms` while the page is visible; never while it is hidden. */
export function useVisibleRefresh(ms: number = REFRESH_MS): void {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    last.current = Date.now();
    const tick = (): void => {
      if (document.visibilityState !== "visible") return;
      last.current = Date.now();
      router.refresh();
    };
    const id = window.setInterval(tick, ms);
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= ms) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, ms]);
}

export function ControlRoomClient({
  briefing,
  children,
}: {
  briefing: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState(false);
  const seen = useSyncExternalStore(noopSubscribe, seenBoot, () => false);
  const boot: "on" | "done" = ended || seen ? "done" : "on";
  const speech = useSyncExternalStore(noopSubscribe, hasSpeech, () => false);
  const [speaking, setSpeaking] = useState(false);
  const [full, setFull] = useState(false);
  useVisibleRefresh();

  // Boot ends by itself, or at the first key press or tap (skippable by any key/tap).
  useEffect(() => {
    if (boot !== "on") return;
    const end = (): void => {
      markBoot();
      setEnded(true);
    };
    const timer = window.setTimeout(end, BOOT_MS);
    window.addEventListener("keydown", end, { once: true });
    window.addEventListener("pointerdown", end, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", end);
      window.removeEventListener("pointerdown", end);
    };
  }, [boot]);

  // A ring segment links to the part's anchor; open its details and move focus there.
  useEffect(() => {
    const open = (): void => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const el = document.getElementById(id);
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.querySelector("summary")?.focus({ preventScroll: true });
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  useEffect(() => {
    const onFs = (): void => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      /* full screen refused by the browser: nothing to do */
    }
  }, []);

  const readAloud = useCallback(() => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const u = new SpeechSynthesisUtterance(briefing);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  }, [briefing, speaking]);

  useEffect(
    () => () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window)
        window.speechSynthesis.cancel();
    },
    [],
  );

  const btn =
    "inline-flex min-h-6 items-center rounded-md border border-border bg-surface px-3 py-1 text-sm";
  return (
    <div ref={root} className={`${styles.root} flex flex-col gap-6`} data-boot={boot}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-sm text-text-muted">
          Updates every 60 seconds while this page is open and visible.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={toggleFull} aria-pressed={full}>
            {full ? "Leave Focus mode" : "Focus mode"}
          </button>
          {speech && (
            <button type="button" className={btn} onClick={readAloud}>
              {speaking ? "Stop reading" : "Read aloud the status briefing"}
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
