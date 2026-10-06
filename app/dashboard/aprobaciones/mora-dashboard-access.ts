import "server-only";
import { redirect } from "next/navigation";
import { getMoraActor } from "@/lib/analyst-mora-access";

export async function requireMoraDashboardAccess() {
  const actor = await getMoraActor().catch(() => null);
  if (!actor) redirect("/dashboard/aprobaciones");
  return { actor, user: { nombre: actor.nombre, rolNombre: actor.centralAdmin ? "ADMIN" : "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY" } };
}
