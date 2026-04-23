"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export default function FinancialAccessReset() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.startsWith("/dashboard/financiero")) {
      return;
    }

    void fetch("/api/financiero/acceso", {
      method: "DELETE",
      credentials: "include",
    });
  }, [pathname]);

  return null;
}
