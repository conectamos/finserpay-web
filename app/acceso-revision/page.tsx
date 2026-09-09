import type { Metadata } from "next";
import SharedAccessClient from "./shared-access-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Acceso compartido a revisión | FINSER PAY",
  robots: { index: false, follow: false, nocache: true, noarchive: true },
  referrer: "no-referrer",
};

export default function SharedAccessPage() {
  return <SharedAccessClient />;
}
