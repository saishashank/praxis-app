"use client";
// Home motion (UXR-056): a counter that counts up and a badge pop, both at most 200 ms and both off under
// "Motion: Off" (html[data-motion="off"]) and prefers-reduced-motion. The server renders the final text,
// so no-JS and tests see the real value; the animation only runs after mount.
import { useEffect, useRef, type ReactNode } from "react";

const MAX_MS = 200; // threshold-ok: UXR-056 motion ceiling

function motionAllowed(): boolean {
  try {
    if (document.documentElement.dataset.motion === "off") return false;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Counts from 0 to `value` once. Screen readers get the final text through `label`, not the frames. */
export function CountUp({
  value,
  decimals = 2,
  prefix = "",
  suffix = "",
  label,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Final text for assistive technology. */
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const fmt = (n: number) => `${prefix}${n.toFixed(decimals)}${suffix}`;
  useEffect(() => {
    const el = ref.current;
    if (!el || !motionAllowed()) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / MAX_MS);
      el.textContent = fmt(value * k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = fmt(value);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fmt only depends on the props below
  }, [value, decimals, prefix, suffix]);
  return (
    <span className={className} data-countup="">
      <span className="sr-only">{label}</span>
      <span ref={ref} aria-hidden="true">
        {fmt(value)}
      </span>
    </span>
  );
}

/** Wraps a badge so it pops in once when the page opens. */
export function PopIn({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !motionAllowed() || typeof el.animate !== "function") return;
    el.animate(
      [
        { transform: "scale(0.85)", opacity: 0.4 },
        { transform: "scale(1.06)", opacity: 1, offset: 0.7 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: MAX_MS, easing: "ease-out" },
    );
  }, []);
  return (
    <span ref={ref} className={className} data-pop="" style={{ display: "inline-flex" }}>
      {children}
    </span>
  );
}
