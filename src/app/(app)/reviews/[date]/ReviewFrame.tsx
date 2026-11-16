"use client";
// The stored Evening Review in a frame (M21 C1, D-1203; UXN-320 a). The HTML is Praxis's own e-mail, frozen at send
// time and shown exactly as sent. sandbox="allow-same-origin" and never "allow-scripts": nothing in the frame can
// run a script, and the parent (this component) may read the frame document, which is how it sizes the frame to
// its content with no blank band and no inner scroll. The frame is srcdoc, so it inherits the app's CSP (no
// inline script) and frame-ancestors does not apply to it. The stored HTML is never rendered by the parent itself.
import { useCallback, useEffect, useRef, useState } from "react";
import { REVIEW_FRAME_MIN_PX, clampReviewHeightPx } from "./reviewHeight";

export function ReviewFrame({
  title,
  html,
  initialHeightPx,
}: {
  title: string;
  html: string;
  initialHeightPx: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(clampReviewHeightPx(initialHeightPx));
  const height0 = useRef(height);
  const width0 = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    let doc: Document | null = null;
    try {
      doc = el?.contentDocument ?? null;
    } catch {
      doc = null; // a frame that is not readable keeps its estimate
    }
    if (el === null || doc === null) return;
    // A frame taller than its content reports its own height: shorten it first so the content decides.
    el.style.height = `${REVIEW_FRAME_MIN_PX}px`;
    const px = doc.documentElement.scrollHeight;
    const h = px > 0 ? clampReviewHeightPx(px) : height0.current;
    el.style.height = `${h}px`;
    height0.current = h;
    width0.current = el.clientWidth;
    setHeight(h);
  }, []);

  // The text reflows only when the frame's width changes (a phone's URL bar resizes the height alone and must not
  // make the reader jump): measure again then, once per animation frame.
  useEffect(() => {
    const onResize = () => {
      if (raf.current !== null) return;
      raf.current = window.requestAnimationFrame(() => {
        raf.current = null;
        const el = ref.current;
        if (el !== null && el.clientWidth !== width0.current) measure();
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf.current !== null) window.cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [measure]);

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={measure}
      style={{ height: `${height}px` }}
      className="block w-full rounded border border-border bg-white"
    />
  );
}
