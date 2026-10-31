import type { ReactNode } from "react";
import { requireDashboardAccess } from "@/lib/dashboard-access";
import { canReviewCreditApprovals } from "@/lib/roles";
import WelcomePendingAlerts from "./_components/welcome-pending-alerts";
import AttentionNotifications from "./_components/attention-notifications";
import { getAttentionWorkAccess } from "@/lib/atencion-work-access";
import { AttentionError } from "@/lib/atencion-core";

export const metadata = { manifest: "/dashboard/manifest.webmanifest" };

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await requireDashboardAccess({ allowApprovalAnalyst: true });
  const mode = access.admin || access.approvalAnalyst ? "attention" : "seller";
  const notificationActor = await getAttentionWorkAccess(mode).catch((error: unknown) => {
    if (error instanceof AttentionError && [401, 403].includes(error.status)) return null;
    throw error;
  });
  const actorKey = notificationActor ? notificationActor.type === "attention" ? `user:${notificationActor.actor.userId}` : `seller:${notificationActor.sellerId}` : null;
  const profileKey = notificationActor ? notificationActor.type === "attention" ? notificationActor.actor.key : notificationActor.key : null;
  const endpoint = notificationActor ? notificationActor.type === "attention" ? "/api/atencion/notificaciones" : "/api/ventas/atencion/notificaciones" : null;

  return <AttentionNotifications key={profileKey || "no-notification-profile"} actorKey={actorKey} endpoint={endpoint}>
    {children}
    {canReviewCreditApprovals(access.session)
      ? <WelcomePendingAlerts key={access.session.id} actorKey={`user-${access.session.id}`} />
      : null}
  </AttentionNotifications>;
}
