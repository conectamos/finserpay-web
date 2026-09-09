import { redirect } from "next/navigation";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { getAllyPaymentAccess } from "@/lib/ally-payment-access";
import BlacklistConsole from "./blacklist-console";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Lista negra | FINSER PAY",
  description: "Control central de cédulas bloqueadas para todos los aliados",
};

export default async function BlacklistPage() {
  const access = await getAllyPaymentAccess();

  if (!access.ok) redirect(access.status === 401 ? "/" : "/dashboard");
  if (access.kind !== "CENTRAL_ADMIN") redirect("/dashboard");

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/lista-negra"
          adminCentral
          nombreUsuario={access.user.nombre}
          rolUsuario={access.user.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Administración"
        current="LISTA NEGRA"
        userName={access.user.nombre}
        userRole={access.user.rolNombre}
      />
      <BlacklistConsole />
    </AppShell>
  );
}
