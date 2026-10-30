import "server-only";
import { getSessionUser } from "./auth";
import { getSellerSessionUser } from "./seller-auth";
import { AttentionError, getAttentionAccess } from "./atencion-core";
import type { AttentionWorkActor } from "./atencion-work-types";

export async function getAttentionWorkAccess(mode: "seller" | "attention"): Promise<AttentionWorkActor> {
  if (mode === "attention") return { type: "attention", actor: await getAttentionAccess() };
  const user = await getSessionUser();
  if (!user) throw new AttentionError("Inicia sesión para consultar tus solicitudes.", 401);
  const seller = await getSellerSessionUser(user);
  if (!seller || seller.debeCambiarPin || !user.activo || !user.aliadoId || !user.sedeAccesoActiva || !user.aliadoAccesoActivo)
    throw new AttentionError("Abre tu perfil de asesor y completa el cambio de PIN para continuar.", 403);
  return { type: "seller", userId: user.id, userSedeId: user.sedeAccesoId, sellerId: seller.id,
    sedeId: seller.sedeId, accessSedeId: seller.accesoSedeId, aliadoId: user.aliadoId,
    supervisor: seller.tipoPerfil === "SUPERVISOR", name: seller.nombre, key: `seller:${user.id}:${seller.id}` };
}
