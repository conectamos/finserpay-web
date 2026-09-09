import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import {
  SELLER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  getSessionCredentialVersion,
  verifySellerSessionToken,
  verifySessionToken,
} from "@/lib/session";
import { canReviewCreditApprovals, isAdminRole, isApprovalAnalystRole } from "@/lib/roles";
import {
  ensureAliadoSchema,
  ensureFinserPayCentralAdmin,
} from "@/lib/aliados";

export async function getSessionUser(options: { allowApprovalAnalyst?: boolean } = {}) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  const session = verifySessionToken(sessionToken);

  if (!session) return null;

  await ensureAliadoSchema(prisma);
  await ensureFinserPayCentralAdmin(prisma);

  const user = await prisma.usuario.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      nombre: true,
      usuario: true,
      activo: true,
      claveHash: true,
      updatedAt: true,
      sedeId: true,
      rolId: true,
      rol: {
        select: {
          id: true,
          nombre: true,
          descripcion: true,
        },
      },
      sede: {
        select: {
          id: true,
          nombre: true,
          aliadoId: true,
          aliado: {
            select: {
              id: true,
              nombre: true,
              codigo: true,
            },
          },
        },
      },
    },
  });

  if (!user || !user.activo) return null;

  // Operational callers deny the specialist by default, including API routes
  // that historically required only a session. Approval routes opt in explicitly.
  const approvalAnalyst = isApprovalAnalystRole(user.rol?.nombre);
  if (approvalAnalyst && (
    !options.allowApprovalAnalyst ||
    !canReviewCreditApprovals({
      rolNombre: user.rol.nombre,
      aliadoAccesoCodigo: user.sede?.aliado?.codigo,
    }) ||
    session.credentialVersion !== getSessionCredentialVersion(user.claveHash, user.updatedAt)
  )) return null;

  const sellerSession = verifySellerSessionToken(
    cookieStore.get(SELLER_SESSION_COOKIE_NAME)?.value
  );
  const canUseSellerSede =
    sellerSession &&
    sellerSession.userId === user.id &&
    !isAdminRole(user.rol?.nombre) &&
    !approvalAnalyst &&
    (!sellerSession.accesoSedeId || sellerSession.accesoSedeId === user.sedeId);

  const operatingSede = canUseSellerSede
    ? await prisma.sede.findFirst({
        where: {
          id: sellerSession.sedeId,
          activa: true,
        },
        select: {
          id: true,
          nombre: true,
          aliadoId: true,
          aliado: {
            select: {
              id: true,
              nombre: true,
              codigo: true,
            },
          },
        },
      })
    : null;

  const effectiveSedeId = operatingSede?.id ?? user.sedeId;
  const effectiveSedeNombre =
    operatingSede?.nombre ?? user.sede?.nombre ?? `SEDE ${user.sedeId}`;
  const effectiveAliado =
    operatingSede?.aliado ?? user.sede?.aliado ?? null;
  const effectiveAliadoId =
    operatingSede?.aliadoId ?? user.sede?.aliadoId ?? null;

  return {
    id: user.id,
    nombre: user.nombre,
    usuario: user.usuario,
    activo: user.activo,
    sedeId: effectiveSedeId,
    sedeNombre: effectiveSedeNombre,
    aliadoId: effectiveAliadoId,
    aliadoNombre: effectiveAliado?.nombre ?? null,
    aliadoCodigo: effectiveAliado?.codigo ?? null,
    sedeAccesoId: user.sedeId,
    sedeAccesoNombre: user.sede?.nombre ?? `SEDE ${user.sedeId}`,
    aliadoAccesoId: user.sede?.aliadoId ?? null,
    aliadoAccesoNombre: user.sede?.aliado?.nombre ?? null,
    aliadoAccesoCodigo: user.sede?.aliado?.codigo ?? null,
    rolId: user.rolId,
    rolNombre: user.rol?.nombre ?? "",
  };
}

export async function getCreditApprovalSessionUser() {
  const user = await getSessionUser({ allowApprovalAnalyst: true });
  return canReviewCreditApprovals(user) ? user : null;
}
