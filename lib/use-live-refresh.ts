"use client";

import { useEffect, useRef } from "react";

const LIVE_REFRESH_EVENT = "conectamos:live-refresh";
const LIVE_REFRESH_STORAGE_KEY = "conectamos:live-refresh";

type UseLiveRefreshOptions = {
  enabled?: boolean;
  intervalMs?: number;
  runOnMount?: boolean;
};

export function triggerLiveRefresh(source = "manual") {
  if (typeof window === "undefined") {
    return;
  }

  const payload = JSON.stringify({
    source,
    ts: Date.now(),
  });

  window.dispatchEvent(new CustomEvent(LIVE_REFRESH_EVENT, { detail: payload }));

  try {
    window.localStorage.setItem(LIVE_REFRESH_STORAGE_KEY, payload);
  } catch {}
}

export function useLiveRefresh(
  refresh: () => Promise<unknown> | void,
  options: UseLiveRefreshOptions = {}
) {
  const { enabled = true, intervalMs = 10000, runOnMount = false } = options;
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const runRefresh = () => {
      void refreshRef.current();
    };

    const handleFocus = () => {
      runRefresh();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        runRefresh();
      }
    };

    const handlePageShow = () => {
      runRefresh();
    };

    const handleCustomRefresh = () => {
      runRefresh();
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === LIVE_REFRESH_STORAGE_KEY) {
        runRefresh();
      }
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener(LIVE_REFRESH_EVENT, handleCustomRefresh);
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", handleVisibility);

    if (runOnMount) {
      runRefresh();
    }

    const intervalId = window.setInterval(() => {
      if (!document.hidden) {
        runRefresh();
      }
    }, intervalMs);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener(LIVE_REFRESH_EVENT, handleCustomRefresh);
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, runOnMount]);
}
