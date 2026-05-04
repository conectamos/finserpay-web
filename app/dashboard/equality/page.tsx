import { requireAdminDashboardAccess } from "@/lib/dashboard-access";
import EqualityZeroTouchConsole from "./equality-zero-touch-console";

export const metadata = {
  title: "Zero Touch | FINSER PAY",
  description: "Consola remota para Equality HBM Zero Touch",
};

export default async function EqualityPage() {
  const { session } = await requireAdminDashboardAccess();

  return (
    <EqualityZeroTouchConsole
      canAdmin
      roleName={session.rolNombre}
    />
  );
}
