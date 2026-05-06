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

    const registerWorker = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.warn("No se pudo registrar la app Android de FINSER PAY:", error);
      });
    };

    if (document.readyState === "complete") {
      registerWorker();
      return;
    }

    window.addEventListener("load", registerWorker, { once: true });

    return () => {
      window.removeEventListener("load", registerWorker);
    };
  }, []);

  return null;
}
