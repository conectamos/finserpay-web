import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import {
  SELLER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  APPROVAL_ANALYST_SESSION_COOKIE_NAME,
  APPROVAL_ACCESS_COOKIE_NAME,
  getSessionCredentialVersion,
  verifyApprovalAnalystSessionToken,
  verifySellerSessionToken,
  verifySessionToken,
} from "@/lib/session";
import { canReviewCreditApprovals, isAdminRole, isApprovalAnalystRole } from "@/lib/roles";
import {
  ensureAliadoSchema,
  ensureFinserPayCentralAdmin,
} from "@/lib/aliados";

export async function getSessionUser(options: { allowApprovalAnalyst?: boolean; preferApprovalAccess?: boolean } = {}) {
  const cookieStore = await cookies();
  const regularToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const analystToken = options.allowApprovalAnalyst
    ? cookieStore.get(APPROVAL_ANALYST_SESSION_COOKIE_NAME)?.value
    : undefined;
  const accessToken = options.allowApprovalAnalyst ? cookieStore.get(APPROVAL_ACCESS_COOKIE_NAME)?.value : undefined;
  const usingAnalystCookie = Boolean(analystToken);
  const usingAccessCookie = !usingAnalystCookie && Boolean(accessToken && (options.preferApprovalAccess || !regularToken));
  const sessionToken = usingAnalystCookie ? analystToken : usingAccessCookie ? accessToken : regularToken;

  const analystSession = usingAnalystCookie
    ? verifyApprovalAnalystSessionToken(sessionToken)
    : null;
  const regularSession = usingAnalystCookie
    ? null
    : verifySessionToken(sessionToken);
  const session = analystSession ?? regularSession;
  const approvalAccessGrantId = regularSession?.approvalAccessGrantId;

  if (!session || (usingAccessCookie && !approvalAccessGrantId)) return null;

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
          activa: true,
          aliadoId: true,
          aliado: {
            select: {
              id: true,
              nombre: true,
              codigo: true,
              activo: true,
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
  // The dedicated cookie is permanently bound to the analyst role. A later
  // promotion cannot turn the remaining 8-hour token into an admin session.
  if (usingAnalystCookie && !approvalAnalyst) return null;
  if (approvalAnalyst && (
    !options.allowApprovalAnalyst ||
    (!usingAnalystCookie && !usingAccessCookie) ||
    !canReviewCreditApprovals({
      rolNombre: user.rol.nombre,
      aliadoAccesoCodigo: user.sede?.aliado?.codigo,
      sedeAccesoActiva: user.sede?.activa,
      aliadoAccesoActivo: user.sede?.aliado?.activo,
    }) ||
    session.credentialVersion !== getSessionCredentialVersion(user.claveHash, user.updatedAt)
  )) return null;

  if (approvalAccessGrantId) {
    // A link can never become an administrative/seller login after a role change.
    if (!approvalAnalyst) return null;
    const grants = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id"::text FROM "CreditApprovalAccessLink" WHERE "userId" = $1 AND "id" = $2::uuid AND "credentialVersion" = $3 AND "revokedAt" IS NULL
        AND EXISTS (SELECT 1 FROM "Sede" site JOIN "Aliado" ally ON ally."id" = site."aliadoId"
          WHERE site."id" = $4 AND site."activa" = TRUE AND ally."activo" = TRUE AND UPPER(BTRIM(ally."codigo")) = 'FINSERPAY')`,
      user.id, approvalAccessGrantId, session.credentialVersion, user.sedeId
    );
    if (!grants.length) return null;
  }

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
    sedeAccesoActiva: user.sede?.activa ?? false,
    aliadoAccesoActivo: user.sede?.aliado?.activo ?? false,
    rolId: user.rolId,
    rolNombre: user.rol?.nombre ?? "",
  };
}

export async function getCreditApprovalSessionUser() {
  const user = await getSessionUser({ allowApprovalAnalyst: true, preferApprovalAccess: true });
  return canReviewCreditApprovals(user) ? user : null;
}

/**
 * Returns an approval analyst only when the request carries the dedicated
 * password-login cookie. Personal or shared approval links must never gain
 * access to nominal support tools such as SADMIN or DataCrédito releases.
 */
export async function getNominalApprovalAnalystSessionUser() {
  const cookieStore = await cookies();
  if (!cookieStore.get(APPROVAL_ANALYST_SESSION_COOKIE_NAME)?.value) return null;

  const user = await getSessionUser({ allowApprovalAnalyst: true });
  return user && isApprovalAnalystRole(user.rolNombre) && canReviewCreditApprovals(user)
    ? user
    : null;
}
