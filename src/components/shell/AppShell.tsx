// The signed-in page frame: skip link, header, banners, breadcrumb, the page, footer. The toast
// provider is mounted here once, so any page component may call useToast() (UXR-046). The page keeps
// its own <main> landmark (every page renders one); this frame adds header, nav and footer landmarks
// and leaves room for the phone bottom bar. It is NOT a guard: each page calls requireUser (D-038).
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { AppHeader, type HeaderProps } from "./AppHeader";
import { Banners, type BannerView } from "./Banners";
import { Crumbs } from "./Crumbs";
import { Footer } from "./Footer";

export const CONTENT_ID = "content";

export type AppShellProps = HeaderProps & { banners: BannerView[]; children: ReactNode };

export function AppShell({ banners, children, ...header }: AppShellProps) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col pb-16 lg:pb-0">
        <a
          href={`#${CONTENT_ID}`}
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-contrast"
        >
          Skip to main content
        </a>
        <AppHeader {...header} />
        <Banners banners={banners} />
        <Crumbs />
        <div id={CONTENT_ID} tabIndex={-1} className="flex-1 outline-none">
          {children}
        </div>
        <Footer />
      </div>
    </ToastProvider>
  );
}
