import type { ReactNode } from "react";
import { requireDashboardAccess } from "@/lib/dashboard-access";
import { canReviewCreditApprovals } from "@/lib/roles";
import WelcomePendingAlerts from "./_components/welcome-pending-alerts";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await requireDashboardAccess({ allowApprovalAnalyst: true });

  return <>
    {children}
    {canReviewCreditApprovals(access.session)
      ? <WelcomePendingAlerts key={access.session.id} actorKey={`user-${access.session.id}`} />
      : null}
  </>;
}
