"use client";

import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const isSecureContext =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (!isSecureContext) {
      return;
    }

    let hasHadController = Boolean(navigator.serviceWorker.controller);
    let registration: ServiceWorkerRegistration | null = null;
    let updateInterval: number | undefined;
    let disposed = false;
    let reloading = false;
    let updatePending = false;

    const tryReload = () => {
      if (
        disposed || reloading || !updatePending ||
        document.visibilityState !== "visible" ||
        !/^\/clientes(?:\/|$)/.test(window.location.pathname) ||
        !document.querySelector('#cliente-dashboard[data-client-update-safe="true"]')
      ) return;

      reloading = true;
      window.location.reload();
    };

    const updateWorker = () => {
      tryReload();
      registration?.update().catch((error) => {
        console.warn("No se pudo actualizar la app de FINSER PAY:", error);
      });
    };

    const handleControllerChange = () => {
      if (
        disposed ||
        reloading ||
        !navigator.serviceWorker.controller
      ) {
        return;
      }

      if (!hasHadController) {
        hasHadController = true;
        return;
      }

      updatePending = true;
      tryReload();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        updateWorker();
      }
    };

    const registerWorker = async () => {
      try {
        const workerRegistration = await navigator.serviceWorker.register(
          "/sw.js",
          { updateViaCache: "none" }
        );

        if (disposed) {
          return;
        }

        registration = workerRegistration;
        updateWorker();
        updateInterval = window.setInterval(updateWorker, 30 * 60 * 1000);
      } catch (error) {
        console.warn("No se pudo registrar la app Android de FINSER PAY:", error);
      }
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange
    );
    window.addEventListener("focus", updateWorker);
    window.addEventListener("pageshow", updateWorker);
    window.addEventListener("finserpay:client-update-safe", tryReload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (document.readyState === "complete") {
      void registerWorker();
    } else {
      window.addEventListener("load", registerWorker, { once: true });
    }

    return () => {
      disposed = true;
      window.removeEventListener("load", registerWorker);
      window.removeEventListener("focus", updateWorker);
      window.removeEventListener("pageshow", updateWorker);
      window.removeEventListener("finserpay:client-update-safe", tryReload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange
      );

      if (updateInterval !== undefined) {
        window.clearInterval(updateInterval);
      }
    };
  }, []);

  return null;
}
