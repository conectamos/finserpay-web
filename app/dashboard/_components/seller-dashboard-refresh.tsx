"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLiveRefresh } from "@/lib/use-live-refresh";

export default function SellerDashboardRefresh() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const refreshingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPending) refreshingRef.current = false;
  }, [isPending]);

  useLiveRefresh(() => {
    if (document.visibilityState !== "visible" || refreshingRef.current || timerRef.current !== null) return;

    // Focus, pageshow and visibility can arrive together when returning to a tab.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (document.visibilityState !== "visible" || refreshingRef.current) return;
      refreshingRef.current = true;
      startTransition(() => router.refresh());
    }, 250);
  }, { intervalMs: 60_000, runOnMount: true });

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return null;
}
