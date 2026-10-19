type SolicitudSellerActor = {
  id: number;
  tipoPerfil?: string | null;
} | null;

type SolicitudOwnerContext = {
  usuarioId?: number | null;
  vendedorId?: number | null;
  aliadoId?: number | null;
} | null;

function positiveId(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function canActAsAllySalesAdmin(user: {
  id?: number;
  rolNombre?: string | null;
  activo?: boolean;
  sedeId?: number | null;
  aliadoId?: number | null;
  sedeAccesoId?: number | null;
  aliadoAccesoId?: number | null;
  sedeAccesoActiva?: boolean;
  aliadoAccesoActivo?: boolean;
  aliadoAccesoCodigo?: string | null;
} | null | undefined) {
  return Boolean(
    user && String(user.rolNombre || "").trim().toUpperCase() === "ADMIN" &&
      String(user.aliadoAccesoCodigo || "").trim().toUpperCase() !== "FINSERPAY" &&
      user.activo === true && user.sedeAccesoActiva === true &&
      user.aliadoAccesoActivo === true && positiveId(user.id) &&
      positiveId(user.aliadoId) && positiveId(user.sedeId) &&
      positiveId(user.aliadoId) === positiveId(user.aliadoAccesoId) &&
      positiveId(user.sedeId) === positiveId(user.sedeAccesoId)
  );
}

export function isDirectSalesProfile(value: unknown) {
  const profile = String(value || "").trim().toUpperCase();
  return profile === "VENDEDOR" || profile === "SUPERVISOR";
}

export function canSellerOperateSolicitud(
  seller: SolicitudSellerActor,
  viewerAllyId: number | null | undefined,
  owner: SolicitudOwnerContext
) {
  const sellerId = positiveId(seller?.id);
  const allyId = positiveId(viewerAllyId);
  const ownerSellerId = positiveId(owner?.vendedorId);
  const ownerAllyId = positiveId(owner?.aliadoId);

  return Boolean(
    isDirectSalesProfile(seller?.tipoPerfil) &&
      sellerId &&
      allyId &&
      sellerId === ownerSellerId &&
      allyId === ownerAllyId
  );
}

export function canOperateSolicitud(input: {
  central: boolean;
  admin?: boolean;
  userId?: number;
  seller: SolicitudSellerActor;
  viewerAllyId: number | null | undefined;
  owner: SolicitudOwnerContext;
}) {
  if (!input.owner) return false;
  return (
    input.central ||
    canAllyAdminOperateSolicitud(input) ||
    canSellerOperateSolicitud(input.seller, input.viewerAllyId, input.owner)
  );
}

export function canAllyAdminOperateSolicitud(input: {
  admin?: boolean;
  userId?: number;
  viewerAllyId: number | null | undefined;
  owner: SolicitudOwnerContext;
}) {
  const userId = positiveId(input.userId);
  const allyId = positiveId(input.viewerAllyId);
  return Boolean(
    input.admin && userId && allyId && input.owner &&
      input.owner.vendedorId === null &&
      positiveId(input.owner.usuarioId) === userId &&
      positiveId(input.owner.aliadoId) === allyId
  );
}

export function canOriginateSolicitud(input: {
  central: boolean;
  admin?: boolean;
  userId?: number;
  viewerAllyId: number | null | undefined;
  seller: SolicitudSellerActor;
}) {
  return Boolean(
    input.central ||
      (input.admin && positiveId(input.userId) && positiveId(input.viewerAllyId)) ||
      (positiveId(input.seller?.id) && positiveId(input.viewerAllyId) &&
        isDirectSalesProfile(input.seller?.tipoPerfil))
  );
}
