import type { Metadata } from "next";
import ApprovalAccessClient from "./approval-access-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Acceso a aprobaciones | FINSER PAY",
  robots: { index: false, follow: false, nocache: true, noarchive: true },
  referrer: "no-referrer",
};

export default function ApprovalAccessPage() {
  return <ApprovalAccessClient />;
}
