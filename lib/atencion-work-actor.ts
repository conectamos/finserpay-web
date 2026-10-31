import "server-only";
import { AttentionError, assertAttentionActor } from "./atencion-core";
import { assertAttentionCurrentActor, type AttentionDb } from "./atencion-storage";
import type { AttentionWorkActor } from "./atencion-work-types";

export const attentionWorkRecipientKey = (actor: AttentionWorkActor) => actor.type === "attention"
  ? `user:${actor.actor.userId}` : `seller:${actor.sellerId}`;

/** Lock the current nominal account/profile while persisting or reading its data. */
export async function assertAttentionWorkCurrentActor(db: AttentionDb, actor: AttentionWorkActor): Promise<AttentionWorkActor> {
  if (actor.type === "attention") {
    assertAttentionActor(actor.actor);
    await assertAttentionCurrentActor(db, actor.actor);
    return actor;
  }
  const [current] = await db.$queryRawUnsafe<{name:string;supervisor:boolean}[]>(`SELECT v.nombre AS name,
    upper(v."tipoPerfil")='SUPERVISOR' AS supervisor FROM "Usuario" u
    JOIN "Sede" us ON us.id=u."sedeId" JOIN "Aliado" ua ON ua.id=us."aliadoId"
    JOIN "Vendedor" v ON v.id=$2 JOIN "SedeVendedor" sv ON sv."vendedorId"=v.id AND sv."sedeId"=$3
    JOIN "Sede" s ON s.id=$4 JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE u.id=$1 AND u."sedeId"=$5 AND u.activo AND us.activa AND ua.activo AND v.activo
    AND NOT v."debeCambiarPin" AND sv.activo AND s.activa AND a.activo AND a.id=$6
    AND upper(v."tipoPerfil") IN ('VENDEDOR','SUPERVISOR') FOR SHARE OF u,us,ua,v,sv,s,a`,
    actor.userId,actor.sellerId,actor.accessSedeId,actor.sedeId,actor.userSedeId,actor.aliadoId);
  if (!current || current.supervisor !== actor.supervisor || actor.key !== `seller:${actor.userId}:${actor.sellerId}`)
    throw new AttentionError("El perfil comercial ya no está autorizado.",403);
  return {...actor,name:current.name};
}
