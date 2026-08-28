type SolicitudSellerActor = {
  id: number;
  tipoPerfil?: string | null;
} | null;

type SolicitudOwnerContext = {
  vendedorId?: number | null;
  aliadoId?: number | null;
} | null;

function positiveId(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
    String(seller?.tipoPerfil || "").trim().toUpperCase() === "VENDEDOR" &&
      sellerId &&
      allyId &&
      sellerId === ownerSellerId &&
      allyId === ownerAllyId
  );
}

export function canOperateSolicitud(input: {
  central: boolean;
  seller: SolicitudSellerActor;
  viewerAllyId: number | null | undefined;
  owner: SolicitudOwnerContext;
}) {
  if (!input.owner) return false;
  return (
    input.central ||
    canSellerOperateSolicitud(input.seller, input.viewerAllyId, input.owner)
  );
}
