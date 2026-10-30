import { redirect } from "next/navigation";
import { AppShell } from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { CommercialSidebar } from "@/app/dashboard/_components/seller-commercial-dashboard";
import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import AttentionConsole from "./attention-console";
import styles from "./attention.module.css";

export const metadata = {
  title: "Atención | FINSER PAY",
  description: "Conversaciones, seguimiento y expedientes del equipo de atención.",
};

export default async function AttentionPage() {
  const actor = await getAttentionAccess().catch((error: unknown) => {
    if (error instanceof AttentionError && error.status === 401) redirect("/aliados");
    if (error instanceof AttentionError && error.status === 403) redirect("/dashboard");
    throw error;
  });
  const role = actor.central ? "Administración central" : actor.admin ? "Administrador aliado" : actor.supervisor ? "Supervisor" : "Asesor";
  return <AppShell className={styles.shell} sidebar={actor.admin
    ? <AdminSidebar activeHref="/dashboard/atencion" adminCentral={actor.central} nombreUsuario={actor.name} rolUsuario="ADMIN" />
    : <CommercialSidebar activeHref="/dashboard/atencion" avatarSrc={null} isSupervisor={actor.supervisor} nombre={actor.name} />}>
    <AdminWorkspaceTopbar parent="Atención" current="Conversaciones" userName={actor.name} userRole={role} accentAvatar />
    <main className={styles.main}><AttentionConsole actor={actor} /></main>
  </AppShell>;
}
