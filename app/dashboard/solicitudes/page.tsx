import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import FinserNavigation from "../_components/finser-navigation";
import { LoadingState } from "@/app/_components/finser-ui";
import SolicitudesWallClient from "./solicitudes-wall-client";
import styles from "./solicitudes-list-view.module.css";

export const metadata = { title: "Solicitudes | FINSER PAY", description: "Consulta y continúa tus ventas." };

export default async function SolicitudesPage() {
  const session = await getSessionUser();
  if (!session) return <div className="p-10">No autenticado</div>;
  const admin = isAdminRole(session.rolNombre);
  const sellerSession = admin ? null : await getSellerSessionUser(session);
  if (!admin && !sellerSession) redirect("/dashboard");
  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const isSupervisor = sellerSession?.tipoPerfil === "SUPERVISOR";
  return <div className={styles.shell}>
    <FinserNavigation variant="requests" admin={admin} adminCentral={adminCentral} isSupervisor={isSupervisor} nombreUsuario={sellerSession?.nombre || session.nombre} rolUsuario={admin ? adminCentral ? "Administrador central" : "Administrador aliado" : isSupervisor ? "Supervisor" : "Vendedor"} />
    <main className={styles.main}><Suspense fallback={<LoadingState label="Cargando solicitudes..." />}>
      <SolicitudesWallClient redesign viewerRole={admin ? "ADMIN" : isSupervisor ? "SUPERVISOR" : "SELLER"} />
    </Suspense></main>
  </div>;
}
