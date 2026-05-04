import type { ReactNode } from "react";
import { requireDashboardAccess } from "@/lib/dashboard-access";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireDashboardAccess();

  return children;
}
