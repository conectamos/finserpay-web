import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser, resolveSellerProfileType } from "@/lib/seller-auth";
import { verifyPassword } from "@/lib/password";
import {
  type AvatarPerfilKey,
  normalizarAvatarPerfil,
  normalizarTipoPerfilVendedor,
} from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
import {
  SELLER_SESSION_COOKIE_NAME,
  createSellerSessionToken,
  getSessionCookieOptions,
} from "@/lib/session";
import { ALIADO_FINSER_PAY, isFinserPayCentralAlly } from "@/lib/aliados";
import { isDirectSalesProfile } from "@/lib/solicitud-operation-access";

const recoveryHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function serializeSeller(item: {
  id: number;
  nombre: string;
  documento: string | null;
  telefono: string | null;
  email: string | null;
  activo: boolean;
  debeCambiarPin: boolean;
  tipoPerfil?: string | null;
  avatarKey?: string | null;
}) {
  const tipoPerfil = normalizarTipoPerfilVendedor(
    item.tipoPerfil || resolveSellerProfileType(item.nombre)
  );

  return {
    id: item.id,
    nombre: item.nombre,
    documento: item.documento,
    telefono: item.telefono,
    email: item.email,
    activo: item.activo,
    debeCambiarPin: item.debeCambiarPin,
    tipoPerfil,
    avatarKey: normalizarAvatarPerfil(item.avatarKey, tipoPerfil) satisfies AvatarPerfilKey,
  };
}

function normalizeSedeAccess(value?: string | null) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function isVentasAccessSede(sede?: { nombre?: string | null; codigo?: string | null }) {
  const values = [sede?.nombre, sede?.codigo].map(normalizeSedeAccess);
  return values.some((value) => value === "VENTAS" || value === "VENTA");
}

function isBlockedOperationalSede(sede?: { nombre?: string | null; codigo?: string | null }) {
  const values = [sede?.nombre, sede?.codigo].map(normalizeSedeAccess);
  return values.some(
    (value) =>
      value === "PP" ||
      value === "PRINCIPAL" ||
      value.includes("PRINCIPAL") ||
      value.includes("RECAUDO")
  );
}

function serializeSede(item: { id: number; nombre: string; codigo: string | null }) {
  return {
    id: item.id,
    nombre: item.nombre,
    codigo: item.codigo,
  };
}

async function getOperationalSedes(
  accessSedeId: number,
  aliadoScopeId: number | null
) {
  const sedes = await prisma.sede.findMany({
    where: {
      activa: true,
      NOT: {
        id: accessSedeId,
      },
      ...(aliadoScopeId
        ? { aliadoId: aliadoScopeId }
        : {
            aliado: {
              codigo: {
                not: ALIADO_FINSER_PAY.codigo,
              },
            },
          }),
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
    },
    orderBy: [
      {
        nombre: "asc",
      },
      {
        id: "asc",
      },
    ],
  });

  return sedes.filter((sede) => !isBlockedOperationalSede(sede)).map(serializeSede);
}

async function getAssignedSellersForSede(sedeId: number) {
  await ensureVendorProfileVisualColumns();

  const rows = await prisma.sedeVendedor.findMany({
    where: {
      sedeId,
      activo: true,
      vendedor: {
        activo: true,
      },
    },
    select: {
      vendedor: {
        select: {
          id: true,
          nombre: true,
          documento: true,
          telefono: true,
          email: true,
          activo: true,
          debeCambiarPin: true,
          tipoPerfil: true,
          avatarKey: true,
        },
      },
    },
    orderBy: {
      vendedor: {
        nombre: "asc",
      },
    },
  });

  return rows.map((row) => serializeSeller(row.vendedor));
}

export async function GET(request?: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ code: "AUTH_REQUIRED", error: "No autenticado" }, { status: 401, headers: recoveryHeaders });
    }

    const accessSedeId = user.sedeAccesoId ?? user.sedeId;
    const recoveryValue = request ? new URL(request.url).searchParams.get("recoveryDraftId") : null;
    if (recoveryValue !== null) {
      const draftId = Number(recoveryValue);
      if (!Number.isSafeInteger(draftId) || draftId < 1 || draftId > 2_147_483_647) {
        return NextResponse.json(
          { code: "INVALID_SESSION_RECOVERY", error: "Selecciona una solicitud válida para recuperar la sesión." },
          { status: 400, headers: recoveryHeaders },
        );
      }
      if (user.activo !== true || user.sedeAccesoActiva !== true || user.aliadoAccesoActivo !== true ||
        String(user.rolNombre || "").trim().toUpperCase() === "ADMIN") {
        return NextResponse.json(
          { code: "SESSION_RECOVERY_FORBIDDEN", error: "Ingresa con la cuenta de ventas original para recuperar esta solicitud." },
          { status: 403, headers: recoveryHeaders },
        );
      }
      const allyId = isFinserPayCentralAlly(user.aliadoAccesoCodigo) ? null : user.aliadoAccesoId || -1;
      const context = await prisma.$queryRawUnsafe<Array<{
        draftId: number; userId: number; sellerId: number; sellerName: string; siteId: number; siteName: string;
      }>>(`
        SELECT d."id" AS "draftId", d."usuarioId" AS "userId", v."id" AS "sellerId",
          v."nombre" AS "sellerName", s."id" AS "siteId", s."nombre" AS "siteName"
        FROM "CreditoBorrador" d
        JOIN "Vendedor" v ON v."id" = d."vendedorId"
        JOIN "SedeVendedor" sv ON sv."vendedorId" = v."id" AND sv."sedeId" = $3
        JOIN "Sede" s ON s."id" = d."sedeId"
        JOIN "Aliado" a ON a."id" = s."aliadoId"
        WHERE d."id" = $1 AND d."usuarioId" = $2
          AND d."estado" = 'ABIERTO' AND d."creditoId" IS NULL
          AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
          AND v."activo" = TRUE AND sv."activo" = TRUE
          AND UPPER(BTRIM(v."tipoPerfil")) IN ('VENDEDOR', 'SUPERVISOR')
          AND s."activa" = TRUE AND a."activo" = TRUE
          AND ($4::integer IS NULL OR s."aliadoId" = $4)
        LIMIT 1`, draftId, user.id, accessSedeId, allyId);
      if (!context[0]) {
        return NextResponse.json(
          { code: "SESSION_RECOVERY_FORBIDDEN", error: "La solicitud no está disponible para esta cuenta. Conserva la pantalla original y consulta con el administrador." },
          { status: 403, headers: recoveryHeaders },
        );
      }
      return NextResponse.json({ ok: true, recoveryContext: context[0] }, { headers: recoveryHeaders });
    }
    const [currentSeller, sellers] = await Promise.all([
      getSellerSessionUser(user),
      getAssignedSellersForSede(accessSedeId),
    ]);

    return NextResponse.json({
      ok: true,
      currentSeller,
      sellers,
    }, { headers: recoveryHeaders });
  } catch (error) {
    console.error("ERROR CONSULTANDO SESION DE VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo cargar la sesion del vendedor" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ code: "AUTH_REQUIRED", error: "No autenticado" }, { status: 401, headers: recoveryHeaders });
    }

    await ensureVendorProfileVisualColumns();
    const accessSedeId = user.sedeAccesoId ?? user.sedeId;
    const isCentralUser = isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const aliadoScopeId = isCentralUser
      ? null
      : Number.isInteger(Number(user.aliadoAccesoId || 0)) &&
          Number(user.aliadoAccesoId || 0) > 0
        ? Number(user.aliadoAccesoId)
        : -1;

    const body = (await req.json()) as Record<string, unknown>;
    const vendedorId = Number(body.vendedorId || 0);
    const pin = String(body.pin || "").replace(/\D/g, "").trim();
    const requestedSedeId = Number(body.sedeId || body.operationalSedeId || 0);
    const recovering = body.recoveryDraftId !== undefined || body.expectedUserId !== undefined;
    const recoveryDraftId = Number(body.recoveryDraftId);
    const expectedUserId = Number(body.expectedUserId);

    if (recovering) {
      if (!Number.isSafeInteger(recoveryDraftId) || recoveryDraftId < 1 || recoveryDraftId > 2_147_483_647 ||
        !Number.isSafeInteger(expectedUserId) || expectedUserId < 1 || expectedUserId > 2_147_483_647 ||
        !Number.isSafeInteger(requestedSedeId) || requestedSedeId < 1 || requestedSedeId > 2_147_483_647) {
        return NextResponse.json(
          { code: "INVALID_SESSION_RECOVERY", error: "La solicitud de recuperación no es válida. Conserva esta pantalla y vuelve a intentarlo." },
          { status: 400, headers: recoveryHeaders },
        );
      }
      if (expectedUserId !== user.id) {
        return NextResponse.json(
          { code: "SESSION_USER_CHANGED", error: "La cuenta de ingreso cambió. Recupera el acceso original en otra pestaña y vuelve a intentarlo aquí." },
          { status: 409, headers: recoveryHeaders },
        );
      }
      if (user.activo !== true || user.sedeAccesoActiva !== true || user.aliadoAccesoActivo !== true ||
        String(user.rolNombre || "").trim().toUpperCase() === "ADMIN") {
        return NextResponse.json(
          { code: "SESSION_RECOVERY_FORBIDDEN", error: "Este acceso no permite recuperar el perfil comercial de la solicitud." },
          { status: 403, headers: recoveryHeaders },
        );
      }
    }

    if (!Number.isInteger(vendedorId) || vendedorId <= 0) {
      return NextResponse.json(
        { error: "Selecciona un vendedor valido" },
        { status: 400 }
      );
    }

    if (!pin) {
      return NextResponse.json(
        { error: "Debes ingresar el PIN del vendedor" },
        { status: 400 }
      );
    }

    const assignment = await prisma.sedeVendedor.findFirst({
      where: {
        sedeId: accessSedeId,
        vendedorId,
        activo: true,
        vendedor: {
          activo: true,
        },
      },
      select: {
        vendedor: {
          select: {
            id: true,
            nombre: true,
            documento: true,
            telefono: true,
            email: true,
            activo: true,
            debeCambiarPin: true,
            tipoPerfil: true,
            avatarKey: true,
            pinHash: true,
            pinTemporalHash: true,
          },
        },
        sede: {
          select: {
            id: true,
            nombre: true,
            codigo: true,
          },
        },
      },
    });

    if (!assignment) {
      return NextResponse.json(
        { error: "Ese vendedor no esta asignado a esta sede" },
        { status: 404 }
      );
    }

    if (recovering && !isDirectSalesProfile(assignment.vendedor.tipoPerfil)) {
      return NextResponse.json(
        { code: "SESSION_RECOVERY_FORBIDDEN", error: "El perfil comercial ya no está autorizado para continuar la solicitud." },
        { status: 403, headers: recoveryHeaders },
      );
    }

    const validMainPin = verifyPassword(pin, assignment.vendedor.pinHash);
    const validTempPin = assignment.vendedor.pinTemporalHash
      ? verifyPassword(pin, assignment.vendedor.pinTemporalHash)
      : false;

    if (!validMainPin && !validTempPin) {
      return NextResponse.json(
        { ...(recovering ? { code: "INVALID_SELLER_PIN" } : {}), error: "El PIN ingresado no es correcto" },
        { status: 401, headers: recoveryHeaders }
      );
    }

    if (!recovering) {
      await prisma.vendedor.update({
        where: { id: assignment.vendedor.id },
        data: { ultimoIngresoAt: new Date() },
      });
    }

    const isVentasAccess = isVentasAccessSede(assignment.sede);
    const operationalSedeId = isVentasAccess
      ? requestedSedeId
      : accessSedeId;

    if (isVentasAccess && !operationalSedeId) {
      const sedes = await getOperationalSedes(accessSedeId, aliadoScopeId);

      if (!sedes.length) {
        return NextResponse.json(
          { error: "No hay sedes activas disponibles para realizar la venta" },
          { status: 400 }
        );
      }

      return NextResponse.json({
        ok: true,
        requiresSedeSelection: true,
        seller: serializeSeller(assignment.vendedor),
        availableSedes: sedes,
        mustChangePin: assignment.vendedor.debeCambiarPin,
      });
    }

    const operationalSede = await prisma.sede.findFirst({
      where: {
        id: operationalSedeId,
        activa: true,
        ...(aliadoScopeId
          ? { aliadoId: aliadoScopeId }
          : {
              aliado: {
                codigo: {
                  not: ALIADO_FINSER_PAY.codigo,
                },
              },
            }),
      },
      select: {
        id: true,
        nombre: true,
        codigo: true,
      },
    });

    if (!operationalSede) {
      return NextResponse.json(
        { error: "Selecciona una sede activa para realizar la venta" },
        { status: 400 }
      );
    }

    if (isBlockedOperationalSede(operationalSede)) {
      return NextResponse.json(
        { error: "Esta sede no esta disponible para registrar ventas" },
        { status: 403 }
      );
    }

    if (!isVentasAccess && operationalSede.id !== accessSedeId) {
      return NextResponse.json(
        { error: "Esta sede de acceso no permite operar en otra sede" },
        { status: 403 }
      );
    }

    if (recovering) {
      // Only restore the already selected commercial identity, using its PIN.
      // This query is read-only: recovery never expires, recreates, reassigns or
      // changes the saved content of a request.
      const eligible = await prisma.$queryRawUnsafe<Array<{ id: number }>>(`
        SELECT d."id" FROM "CreditoBorrador" d
        JOIN "Sede" s ON s."id" = d."sedeId"
        JOIN "Aliado" a ON a."id" = s."aliadoId"
        WHERE d."id" = $1 AND d."vendedorId" = $2 AND d."sedeId" = $3
          AND d."estado" = 'ABIERTO' AND d."creditoId" IS NULL
          AND COALESCE(d."expiresAt", d."createdAt" + INTERVAL '15 days') > CURRENT_TIMESTAMP
          AND s."activa" = TRUE AND a."activo" = TRUE
          AND ($4::integer IS NULL OR s."aliadoId" = $4)
        LIMIT 1`, recoveryDraftId, assignment.vendedor.id, operationalSede.id, aliadoScopeId);
      if (!eligible.length) {
        return NextResponse.json(
          { code: "SESSION_RECOVERY_FORBIDDEN", error: "La solicitud no está disponible para este perfil y sede. Conserva los datos y consulta con el administrador." },
          { status: 403, headers: recoveryHeaders },
        );
      }
      await prisma.vendedor.update({
        where: { id: assignment.vendedor.id },
        data: { ultimoIngresoAt: new Date() },
      });
    }

    const response = NextResponse.json({
      ok: true,
      seller: serializeSeller(assignment.vendedor),
      operationalSede: serializeSede(operationalSede),
      mustChangePin: assignment.vendedor.debeCambiarPin,
      ...(recovering ? { recovery: { draftId: recoveryDraftId, userId: user.id, sellerId: assignment.vendedor.id, sedeId: operationalSede.id } } : {}),
    }, { headers: recoveryHeaders });

    response.cookies.set(
      SELLER_SESSION_COOKIE_NAME,
      createSellerSessionToken({
        accesoSedeId: accessSedeId,
        sedeId: operationalSede.id,
        userId: user.id,
        vendedorId: assignment.vendedor.id,
      }),
      getSessionCookieOptions()
    );

    return response;
  } catch (error) {
    console.error("ERROR ABRIENDO PERFIL DE VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo abrir el perfil del vendedor" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(SELLER_SESSION_COOKIE_NAME, "", {
    ...getSessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });

  return response;
}
