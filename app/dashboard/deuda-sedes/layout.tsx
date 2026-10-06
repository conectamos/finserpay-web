import { requireAdminDashboardAccess } from "@/lib/dashboard-access";

export default async function DeudaSedesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminDashboardAccess();
  return children;
}
