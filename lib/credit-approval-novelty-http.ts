import { getSessionUser } from "@/lib/auth";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import type { PendingAllyActor } from "@/lib/credit-approval-novelties";
export async function getPendingAllyActor(): Promise<PendingAllyActor> {
  const user = await getSessionUser();
  if (!user) throw new CreditApprovalError("UNAUTHENTICATED", "Inicia sesión para revisar pendientes.", 401);
  if (user.rolNombre.trim().toUpperCase() !== "ADMIN" || !user.aliadoAccesoId ||
      user.aliadoAccesoCodigo?.trim().toUpperCase() === "FINSERPAY") {
    throw new CreditApprovalError("FORBIDDEN", "No tienes permiso para responder estas novedades.", 403);
  }
  return { id: user.id, nombre: user.nombre, aliadoId: user.aliadoAccesoId };
}
