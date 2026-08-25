import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { obtenerAvatarPerfilSrc } from "@/lib/profile-avatars";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { CommercialSidebar } from "@/app/dashboard/_components/seller-commercial-dashboard";
import { LoadingState } from "@/app/_components/finser-ui";
import SolicitudesWallClient from "./solicitudes-wall-client";

export const metadata = {
  title: "Muro de solicitudes | FINSER PAY",
  description:
    "Seguimiento operativo de solicitudes desde la consulta inicial hasta la entrega.",
};

export default async function SolicitudesPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const admin = isAdminRole(session.rolNombre);
  const sellerSession = admin ? null : await getSellerSessionUser(session);

  if (!admin && !sellerSession) {
    redirect("/dashboard");
  }

  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const sidebar = admin ? (
    <AdminSidebar
      activeHref="/dashboard/solicitudes"
      adminCentral={adminCentral}
      nombreUsuario={session.nombre}
      rolUsuario={session.rolNombre}
    />
  ) : (
    <CommercialSidebar
      activeHref="/dashboard/solicitudes"
      avatarSrc={obtenerAvatarPerfilSrc(sellerSession!.avatarKey)}
      isSupervisor={sellerSession?.tipoPerfil === "SUPERVISOR"}
      nombre={sellerSession?.nombre || session.nombre}
    />
  );

  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-graphite)] lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      {sidebar}

      <div className="min-w-0">
        <AdminWorkspaceTopbar
          parent="Operacion"
          current="Solicitudes"
          userName={sellerSession?.nombre || session.nombre}
          userRole={
            admin
              ? adminCentral
                ? "Administrador central"
                : "Administrador aliado"
              : sellerSession?.tipoPerfil === "SUPERVISOR"
                ? "Supervisor"
                : "Vendedor"
          }
          accentAvatar={!admin}
        />

        <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
          <Suspense fallback={<LoadingState label="Cargando muro de solicitudes..." />}>
            <SolicitudesWallClient
              viewerRole={
                admin
                  ? "ADMIN"
                  : sellerSession?.tipoPerfil === "SUPERVISOR"
                    ? "SUPERVISOR"
                    : "SELLER"
              }
            />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
