import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { resolveSellerProfileType } from "@/lib/seller-auth";
import {
  normalizarAvatarPerfil,
  normalizarTipoPerfilVendedor,
} from "@/lib/profile-avatars";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
import { ensureUserProfileVisualColumns } from "@/lib/user-profile-schema";
import { APPROVAL_ANALYST_ROLE, canManageApprovalAnalysts, isApprovalAnalystRole } from "@/lib/roles";
import { appendApprovalAnalystAccountEvent } from "@/lib/approval-analyst-account-audit";

function isAdminRole(rolNombre: string) {
  return String(rolNombre || "").trim().toUpperCase() === "ADMIN";
}

function normalizeText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value: unknown) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function normalizeDocument(value: unknown) {
  return String(value || "").replace(/\D/g, "").trim();
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function normalizePin(value: unknown) {
  return String(value || "").replace(/\D/g, "").trim();
}

function parseSellerId(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseSedeId(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseSedeIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => Number(item || 0))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );
}

function isValidPin(pin: string) {
  return /^\d{4,6}$/.test(pin);
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) return false;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
    // Railway terminates TLS before Node; Host retains the public authority.
    const publicHost = request.headers.get("host");
    return publicHost
      ? parsed.host.toLowerCase() === publicHost.toLowerCase()
      : parsed.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readUpdateBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function requireAdmin() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  if (!isAdminRole(user.rolNombre)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo el administrador puede gestionar usuarios" },
        { status: 403 }
      ),
    };
  }

  // Only the central ally has global scope. An unassigned admin must fail closed.
  if (!isFinserPayCentralAlly(user.aliadoAccesoCodigo) && !parseSedeId(user.aliadoAccesoId)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "El administrador no tiene un aliado asignado" }, { status: 403 }),
    };
  }

  return {
    ok: true as const,
    user,
  };
}

function getAliadoScope(user: Awaited<ReturnType<typeof getSessionUser>>) {
  if (isFinserPayCentralAlly(user?.aliadoAccesoCodigo)) {
    return null;
  }

  const aliadoId = Number(user?.aliadoAccesoId || 0);

  return Number.isInteger(aliadoId) && aliadoId > 0 ? aliadoId : null;
}

async function loadAdminSellersPayload(aliadoScopeId: number | null, includeAnalysts = false) {
  await Promise.all([
    ensureVendorProfileVisualColumns(),
    ensureUserProfileVisualColumns(),
  ]);

  const [sedes, vendedores, administradores] = await Promise.all([
    prisma.sede.findMany({
      where: {
        activa: true,
        ...(aliadoScopeId ? { aliadoId: aliadoScopeId } : {}),
      },
      select: {
        id: true,
        nombre: true,
        activa: true,
        aliado: {
          select: {
            id: true,
            nombre: true,
            codigo: true,
          },
        },
      },
      orderBy: {
        nombre: "asc",
      },
    }),
    prisma.vendedor.findMany({
      where: {
        activo: true,
        ...(aliadoScopeId
          ? {
              asignaciones: {
                some: {
                  activo: true,
                  sede: {
                    aliadoId: aliadoScopeId,
                  },
                },
              },
            }
          : {}),
      },
      include: {
        asignaciones: {
          where: {
            activo: true,
            ...(aliadoScopeId
              ? {
                  sede: {
                    aliadoId: aliadoScopeId,
                  },
                }
              : {}),
          },
          select: {
            sede: {
              select: {
                id: true,
                nombre: true,
              },
            },
          },
          orderBy: {
            sede: {
              nombre: "asc",
            },
          },
        },
      },
      orderBy: [
        {
          activo: "desc",
        },
        {
          nombre: "asc",
        },
      ],
    }),
    prisma.usuario.findMany({
      where: {
        rol: {
          nombre: includeAnalysts ? { in: ["ADMIN", APPROVAL_ANALYST_ROLE] } : "ADMIN",
        },
        ...(aliadoScopeId
          ? {
              sede: {
                aliadoId: aliadoScopeId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        nombre: true,
        usuario: true,
        avatarKey: true,
        activo: true,
        createdAt: true,
        updatedAt: true,
        sede: {
          select: {
            id: true,
            nombre: true,
            aliado: {
              select: {
                id: true,
                nombre: true,
                codigo: true,
              },
            },
          },
        },
        rol: {
          select: {
            nombre: true,
          },
        },
      },
      orderBy: [
        {
          activo: "desc",
        },
        {
          nombre: "asc",
        },
      ],
    }),
  ]);

  return {
    scope: {
      central: !aliadoScopeId,
      aliadoId: aliadoScopeId,
    },
    sedes,
    analistas: includeAnalysts ? administradores
      .filter((item) => isApprovalAnalystRole(item.rol.nombre))
      .map((item) => ({
        id: item.id, nombre: item.nombre, usuario: item.usuario,
        activo: item.activo, sede: item.sede,
        updatedAt: item.updatedAt.toISOString(),
      })) : [],
    administradores: administradores.filter((item) => !isApprovalAnalystRole(item.rol.nombre)).map((item) => ({
      id: item.id,
      nombre: item.nombre,
      usuario: item.usuario,
      avatarKey: normalizarAvatarPerfil(item.avatarKey, "ADMINISTRADOR"),
      activo: item.activo,
      rolNombre: item.rol.nombre,
      sede: item.sede,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    vendedores: vendedores.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      tipoPerfil: normalizarTipoPerfilVendedor(
        item.tipoPerfil || resolveSellerProfileType(item.nombre)
      ),
      avatarKey: normalizarAvatarPerfil(
        item.avatarKey,
        normalizarTipoPerfilVendedor(
          item.tipoPerfil || resolveSellerProfileType(item.nombre)
        )
      ),
      documento: item.documento,
      telefono: item.telefono,
      email: item.email,
      activo: item.activo,
      debeCambiarPin: item.debeCambiarPin,
      assignedSedeIds: item.asignaciones.map((asignacion) => asignacion.sede.id),
      assignedSedes: item.asignaciones.map((asignacion) => asignacion.sede),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      ultimoIngresoAt: item.ultimoIngresoAt?.toISOString() || null,
    })),
  };
}

async function ensureSedesExist(sedeIds: number[], aliadoScopeId: number | null) {
  const sedes = await prisma.sede.findMany({
    where: {
      id: {
        in: sedeIds,
      },
      activa: true,
      ...(aliadoScopeId ? { aliadoId: aliadoScopeId } : {}),
    },
    select: {
      id: true,
      aliadoId: true,
    },
  });

  if (sedes.length !== sedeIds.length) {
    return false;
  }

  if (!aliadoScopeId) {
    const aliadoIds = new Set(sedes.map((sede) => sede.aliadoId || 0));
    return aliadoIds.size === 1 && !aliadoIds.has(0);
  }

  return true;
}

async function ensureSedeExists(sedeId: number, aliadoScopeId: number | null) {
  const sede = await prisma.sede.findFirst({
    where: {
      id: sedeId,
      activa: true,
      ...(aliadoScopeId ? { aliadoId: aliadoScopeId } : {}),
    },
    select: {
      id: true,
    },
  });

  return Boolean(sede);
}

export async function GET() {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const aliadoScopeId = getAliadoScope(session.user);

    return NextResponse.json({
      ok: true,
      ...(await loadAdminSellersPayload(aliadoScopeId, canManageApprovalAnalysts(session.user))),
    });
  } catch (error) {
    console.error("ERROR LISTANDO VENDEDORES:", error);
    return NextResponse.json(
      { error: "No se pudo cargar la gestion de usuarios" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    await ensureVendorProfileVisualColumns();
    const aliadoScopeId = getAliadoScope(session.user);

    const body = (await req.json()) as Record<string, unknown>;
    const nombre = normalizeText(body.nombre);
    const documento = normalizeDocument(body.documento);
    const telefono = normalizePhone(body.telefono);
    const email = normalizeEmail(body.email);
    const pin = normalizePin(body.pin);
    const sedeIds = parseSedeIds(body.sedeIds);
    const activo = body.activo !== false;
    const tipoPerfilRaw = String(body.tipoPerfil || "").trim().toUpperCase();
    const tipoPerfil = normalizarTipoPerfilVendedor(body.tipoPerfil);
    const avatarKey = normalizarAvatarPerfil(body.avatarKey, tipoPerfil);

    if (tipoPerfilRaw === APPROVAL_ANALYST_ROLE) {
      if (!canManageApprovalAnalysts(session.user)) {
        return NextResponse.json({ error: "Solo el administrador central puede gestionar analistas" }, { status: 403 });
      }
      const usuario = normalizeUsername(body.usuario);
      const clave = String(body.clave || "").trim();
      const sedeId = parseSedeId(body.sedeId);
      if (!nombre || nombre.length > 120 || !/^[a-z0-9._@-]{3,80}$/.test(usuario) || clave.length < 8 || clave.length > 128) {
        return NextResponse.json({ error: "Ingresa nombre, usuario de 3 a 80 caracteres y clave de 8 a 128 caracteres" }, { status: 400 });
      }
      const sede = sedeId ? await prisma.sede.findFirst({
        where: { id: sedeId, activa: true, aliado: { codigo: "FINSERPAY", activo: true } },
        select: { id: true },
      }) : null;
      if (!sede) return NextResponse.json({ error: "Selecciona una sede central activa de FINSER PAY" }, { status: 400 });
      try {
        await prisma.$transaction(async (tx) => {
          const rol = await tx.rol.upsert({
            where: { nombre: APPROVAL_ANALYST_ROLE }, update: {},
            create: { nombre: APPROVAL_ANALYST_ROLE, descripcion: "Revision de creditos para liquidacion a aliados" },
          });
          const analyst = await tx.usuario.create({
            data: { nombre, usuario, claveHash: hashPassword(clave), activo, sedeId: sede.id, rolId: rol.id },
            select: { id: true },
          });
          await appendApprovalAnalystAccountEvent(tx, {
            analystUserId: analyst.id,
            actorUserId: session.user.id,
            eventType: "CREATED",
            accountActive: activo,
          });
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
          return NextResponse.json({ error: "Ya existe un usuario con ese acceso" }, { status: 409 });
        }
        throw error;
      }
      return NextResponse.json({
        ok: true, mensaje: "Analista de aprobacion creado",
        ...(await loadAdminSellersPayload(aliadoScopeId, true)),
      });
    }

    if (tipoPerfilRaw === "ADMINISTRADOR" || tipoPerfilRaw === "ADMIN_CENTRAL") {
      const central = tipoPerfilRaw === "ADMIN_CENTRAL";
      if (central && !canManageApprovalAnalysts(session.user)) {
        return NextResponse.json({ error: "Solo Admin Central FINSER puede crear otro administrador central" }, { status: 403 });
      }
      await ensureUserProfileVisualColumns();

      const usuario = normalizeUsername(body.usuario);
      const clave = typeof body.clave === "string" ? body.clave : typeof body.pin === "string" ? body.pin : "";
      const avatarAdministrador = normalizarAvatarPerfil(
        body.avatarKey,
        "ADMINISTRADOR"
      );
      let sedeId =
        parseSedeId(body.sedeId) ||
        (sedeIds.length === 1 ? sedeIds[0] : null);

      if (!nombre || nombre.length > 120) {
        return NextResponse.json(
          { error: "Ingresa el nombre del administrador, hasta 120 caracteres" },
          { status: 400 }
        );
      }

      if (!/^[a-z0-9._@-]{3,80}$/.test(usuario)) {
        return NextResponse.json(
          { error: "El usuario debe tener entre 3 y 80 caracteres: letras, numeros, punto, guion, guion bajo o @" },
          { status: 400 }
        );
      }

      if (clave.length < 8 || clave.length > 128 || !clave.trim()) {
        return NextResponse.json(
          { error: "La clave inicial debe tener entre 8 y 128 caracteres" },
          { status: 400 }
        );
      }

      if (central && body.confirmarClave !== clave) {
        return NextResponse.json({ error: "Las contraseñas no coinciden" }, { status: 400 });
      }

      if (central) {
        // The client cannot choose another ally or role for a central account.
        const sedeCentral = await prisma.sede.findFirst({
          where: { codigo: "ADMIN-FINSERPAY", activa: true, aliado: { codigo: "FINSERPAY", activo: true } },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        if (!sedeCentral) {
          return NextResponse.json({ error: "No hay una sede central activa de FINSER PAY configurada" }, { status: 409 });
        }
        sedeId = sedeCentral.id;
      }

      if (!sedeId || !(await ensureSedeExists(sedeId, aliadoScopeId))) {
        return NextResponse.json(
          { error: "Debes seleccionar una sede base activa" },
          { status: 400 }
        );
      }

      const existingUser = await prisma.usuario.findUnique({
        where: { usuario },
        select: { id: true },
      });

      if (existingUser) {
        return NextResponse.json(
          { error: "Ya existe un usuario con ese acceso" },
          { status: 409 }
        );
      }

      const adminRole = await prisma.rol.upsert({
        where: { nombre: "ADMIN" },
        update: {},
        create: {
          nombre: "ADMIN",
          descripcion: "Administrador",
        },
        select: {
          id: true,
        },
      });

      try {
        await prisma.usuario.create({
          data: {
            nombre,
            usuario,
            claveHash: hashPassword(clave),
            avatarKey: avatarAdministrador,
            activo,
            rolId: adminRole.id,
            sedeId,
          },
          select: { id: true },
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
          return NextResponse.json({ error: "Ya existe un usuario con ese acceso" }, { status: 409 });
        }
        throw error;
      }

      return NextResponse.json({
        ok: true,
        mensaje: central ? "Admin Central FINSER creado correctamente" : "Administrador creado correctamente",
        ...(await loadAdminSellersPayload(aliadoScopeId, canManageApprovalAnalysts(session.user))),
      });
    }

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del usuario es obligatorio" },
        { status: 400 }
      );
    }

    if (!isValidPin(pin)) {
      return NextResponse.json(
        { error: "El PIN inicial debe tener entre 4 y 6 digitos" },
        { status: 400 }
      );
    }

    if (!sedeIds.length) {
      return NextResponse.json(
        { error: "Debes asignar al menos una sede al usuario" },
        { status: 400 }
      );
    }

    if (!(await ensureSedesExist(sedeIds, aliadoScopeId))) {
      return NextResponse.json(
        { error: "Alguna de las sedes seleccionadas no existe o esta inactiva" },
        { status: 404 }
      );
    }

    if (documento) {
      const existingDocument = await prisma.vendedor.findUnique({
        where: { documento },
        select: { id: true },
      });

      if (existingDocument) {
        return NextResponse.json(
          { error: "Ya existe un usuario con ese documento" },
          { status: 400 }
        );
      }
    }

    await prisma.vendedor.create({
      data: {
        nombre,
        documento: documento || null,
        telefono: telefono || null,
        email: email || null,
        tipoPerfil,
        avatarKey,
        activo,
        pinHash: hashPassword(pin),
        debeCambiarPin: true,
        asignaciones: {
          createMany: {
            data: sedeIds.map((sedeId) => ({
              sedeId,
              activo: true,
            })),
          },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Usuario creado correctamente",
      ...(await loadAdminSellersPayload(aliadoScopeId, canManageApprovalAnalysts(session.user))),
    });
  } catch {
    // Prisma errors can include credential hashes in query parameters.
    console.error("ERROR CREANDO USUARIO: No se pudo completar la operacion");
    return NextResponse.json(
      { error: "No se pudo crear el usuario" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    await ensureVendorProfileVisualColumns();
    const aliadoScopeId = getAliadoScope(session.user);

    if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "Se requiere una solicitud JSON" }, { status: 415 });
    }
    const body = await readUpdateBody(req);
    if (!body) return NextResponse.json({ error: "Solicitud de actualizacion invalida" }, { status: 400 });

    if ("administradorId" in body || String(body.tipoPerfil || "").trim().toUpperCase() === "ADMIN_CENTRAL") {
      if (!canManageApprovalAnalysts(session.user)) {
        return NextResponse.json({ error: "Solo Admin Central FINSER puede gestionar administradores centrales" }, { status: 403 });
      }
      if (!sameOrigin(req)) return NextResponse.json({ error: "Origen de solicitud no permitido" }, { status: 403 });
      const allowedFields = new Set(["tipoPerfil", "administradorId", "nombre", "usuario", "activo", "expectedUpdatedAt"]);
      if (Object.keys(body).some((key) => !allowedFields.has(key))) {
        return NextResponse.json({ error: "Solo puedes editar nombre, usuario y estado del administrador central" }, { status: 400 });
      }
      const administradorId = typeof body.administradorId === "number" ? parseSellerId(body.administradorId) : null;
      const nombre = typeof body.nombre === "string" ? normalizeText(body.nombre) : "";
      const usuario = typeof body.usuario === "string" ? normalizeUsername(body.usuario) : "";
      const expectedUpdatedAt = new Date(typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "");
      if (body.tipoPerfil !== "ADMIN_CENTRAL" || !administradorId || !nombre || nombre.length > 120 ||
          !/^[a-z0-9._@-]{3,80}$/.test(usuario) || typeof body.activo !== "boolean" ||
          !Number.isFinite(expectedUpdatedAt.getTime())) {
        return NextResponse.json({ error: "Ingresa nombre de hasta 120 caracteres, usuario de 3 a 80 caracteres y un estado valido. Actualiza la lista antes de continuar." }, { status: 400 });
      }
      const activo = body.activo;
      if (!activo && administradorId === session.user.id) {
        return NextResponse.json({ error: "No puedes desactivar tu propia cuenta" }, { status: 403 });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const centralScope = {
            rol: { nombre: "ADMIN" },
            sede: { activa: true, aliado: { codigo: "FINSERPAY", activo: true } },
          };
          // Recheck the actor inside the same serializable transaction. Two
          // administrators cannot deactivate each other from stale sessions.
          const actor = await tx.usuario.findFirst({
            where: { id: session.user.id, activo: true, ...centralScope },
            select: { id: true },
          });
          if (!actor) return { status: 403, error: "Tu cuenta ya no tiene acceso administrativo central" };
          const administrator = await tx.usuario.findFirst({
            where: { id: administradorId, ...centralScope },
            select: { id: true, activo: true, updatedAt: true },
          });
          if (!administrator) return { status: 404, error: "Administrador central no encontrado" };
          if (administrator.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
            return { status: 409, error: "El administrador cambio. Actualiza la lista antes de continuar." };
          }
          if (!activo && administrator.activo) {
            const activeCount = await tx.usuario.count({ where: { activo: true, ...centralScope } });
            if (activeCount <= 1) return { status: 409, error: "Debe permanecer al menos un administrador central activo" };
          }
          const duplicate = await tx.usuario.findFirst({
            where: { usuario, id: { not: administradorId } }, select: { id: true },
          });
          if (duplicate) return { status: 409, error: "Ya existe un usuario con ese acceso" };
          const updated = await tx.usuario.updateMany({
            where: { id: administradorId, updatedAt: expectedUpdatedAt, ...centralScope },
            data: {
              nombre, usuario, activo,
              updatedAt: new Date(Math.max(Date.now(), administrator.updatedAt.getTime() + 1)),
            },
          });
          if (updated.count !== 1) return { status: 409, error: "El administrador cambio. Actualiza la lista antes de continuar." };
          return { status: 200 };
        }, { isolationLevel: "Serializable" });

        if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) {
          if (error.code === "P2002") return NextResponse.json({ error: "Ya existe un usuario con ese acceso" }, { status: 409 });
          if (error.code === "P2034") return NextResponse.json({ error: "La gestion de administradores cambio durante la solicitud. Actualiza la lista e intenta nuevamente." }, { status: 409 });
        }
        throw error;
      }
      return NextResponse.json({
        ok: true,
        mensaje: "Administrador central actualizado correctamente",
        ...(await loadAdminSellersPayload(aliadoScopeId, true)),
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if ("analistaId" in body || String(body.tipoPerfil || "").trim().toUpperCase() === APPROVAL_ANALYST_ROLE) {
      if (!canManageApprovalAnalysts(session.user)) {
        return NextResponse.json({ error: "Solo el administrador central puede gestionar analistas" }, { status: 403 });
      }
      const analistaId = parseSellerId(body.analistaId);
      const expectedUpdatedAt = new Date(String(body.expectedUpdatedAt || ""));
      const action = String(body.action || "");
      const clave = String(body.clave || "").trim();
      if (!analistaId || !Number.isFinite(expectedUpdatedAt.getTime()) ||
        !["SET_ACTIVE", "RESET_PASSWORD"].includes(action) ||
        (action === "SET_ACTIVE" && typeof body.activo !== "boolean") ||
        (action === "RESET_PASSWORD" && (clave.length < 8 || clave.length > 128))) {
        return NextResponse.json({ error: "Operacion de analista invalida; la clave debe tener de 8 a 128 caracteres" }, { status: 400 });
      }
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.usuario.updateMany({
          where: {
            id: analistaId, updatedAt: expectedUpdatedAt,
            rol: { nombre: APPROVAL_ANALYST_ROLE },
            sede: { aliado: { codigo: "FINSERPAY" } },
          },
          data: action === "RESET_PASSWORD"
            ? { claveHash: hashPassword(clave) }
            : { activo: body.activo as boolean },
        });
        if (updated.count !== 1) return updated;
        await appendApprovalAnalystAccountEvent(tx, {
          analystUserId: analistaId,
          actorUserId: session.user.id,
          eventType: action === "RESET_PASSWORD" ? "PASSWORD_RESET" : body.activo ? "ACTIVATED" : "DEACTIVATED",
          accountActive: action === "RESET_PASSWORD" ? null : body.activo as boolean,
        });
        return updated;
      });
      if (result.count !== 1) {
        return NextResponse.json({ error: "El analista cambio o ya no esta disponible. Actualiza la lista antes de continuar." }, { status: 409 });
      }
      return NextResponse.json({
        ok: true,
        mensaje: action === "RESET_PASSWORD" ? "Clave del analista restablecida" : body.activo ? "Analista activado" : "Analista desactivado",
        ...(await loadAdminSellersPayload(aliadoScopeId, true)),
      });
    }
    const vendedorId = parseSellerId(body.vendedorId);
    const nombre = normalizeText(body.nombre);
    const documento = normalizeDocument(body.documento);
    const telefono = normalizePhone(body.telefono);
    const email = normalizeEmail(body.email);
    const pin = normalizePin(body.pin);
    const sedeIds = parseSedeIds(body.sedeIds);
    const activo = body.activo !== false;
    const tipoPerfil = normalizarTipoPerfilVendedor(body.tipoPerfil);
    const avatarKey = normalizarAvatarPerfil(body.avatarKey, tipoPerfil);

    if (!vendedorId) {
      return NextResponse.json(
        { error: "Usuario invalido" },
        { status: 400 }
      );
    }

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del usuario es obligatorio" },
        { status: 400 }
      );
    }

    if (pin && !isValidPin(pin)) {
      return NextResponse.json(
        { error: "El PIN debe tener entre 4 y 6 digitos" },
        { status: 400 }
      );
    }

    if (!sedeIds.length) {
      return NextResponse.json(
        { error: "Debes asignar al menos una sede al usuario" },
        { status: 400 }
      );
    }

    const seller = await prisma.vendedor.findFirst({
      where: { id: vendedorId },
      select: {
        id: true,
      },
    });

    if (!seller) {
      return NextResponse.json(
        { error: "Usuario no encontrado" },
        { status: 404 }
      );
    }

    const sellerEnAlcance = aliadoScopeId
      ? await prisma.sedeVendedor.findFirst({
          where: {
            vendedorId,
            activo: true,
            sede: {
              aliadoId: aliadoScopeId,
            },
          },
          select: {
            vendedorId: true,
          },
        })
      : true;

    if (!sellerEnAlcance) {
      return NextResponse.json(
        { error: "No puedes editar usuarios de otro aliado" },
        { status: 403 }
      );
    }

    if (!(await ensureSedesExist(sedeIds, aliadoScopeId))) {
      return NextResponse.json(
        { error: "Alguna de las sedes seleccionadas no existe o esta inactiva" },
        { status: 404 }
      );
    }

    if (documento) {
      const existingDocument = await prisma.vendedor.findFirst({
        where: {
          documento,
          id: {
            not: vendedorId,
          },
        },
        select: { id: true },
      });

      if (existingDocument) {
        return NextResponse.json(
          { error: "Ya existe otro usuario con ese documento" },
          { status: 400 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendedor.update({
        where: { id: vendedorId },
        data: {
          nombre,
          documento: documento || null,
          telefono: telefono || null,
          email: email || null,
          tipoPerfil,
          avatarKey,
          activo,
          ...(pin
            ? {
                pinHash: hashPassword(pin),
                pinTemporalHash: null,
                debeCambiarPin: true,
              }
            : {}),
        },
      });

      await tx.sedeVendedor.deleteMany({
        where: {
          vendedorId,
        },
      });

      await tx.sedeVendedor.createMany({
        data: sedeIds.map((sedeId) => ({
          sedeId,
          vendedorId,
          activo: true,
        })),
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: pin
        ? "Usuario actualizado y PIN reiniciado correctamente"
        : "Usuario actualizado correctamente",
      ...(await loadAdminSellersPayload(aliadoScopeId, canManageApprovalAnalysts(session.user))),
    });
  } catch {
    console.error("ERROR ACTUALIZANDO USUARIO: No se pudo completar la operacion");
    return NextResponse.json(
      { error: "No se pudo actualizar el usuario" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json()) as Record<string, unknown>;
    const vendedorId = parseSellerId(body.vendedorId);
    const aliadoScopeId = getAliadoScope(session.user);

    if (!vendedorId) {
      return NextResponse.json(
        { error: "Usuario invalido" },
        { status: 400 }
      );
    }

    const seller = await prisma.vendedor.findFirst({
      where: {
        id: vendedorId,
        ...(aliadoScopeId
          ? {
              asignaciones: {
                some: {
                  activo: true,
                  sede: {
                    aliadoId: aliadoScopeId,
                  },
                },
              },
            }
          : {}),
      },
      select: {
        id: true,
      },
    });

    if (!seller) {
      return NextResponse.json(
        { error: "Usuario no encontrado" },
        { status: 404 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendedor.update({
        where: { id: vendedorId },
        data: {
          activo: false,
          debeCambiarPin: true,
        },
      });

      await tx.sedeVendedor.updateMany({
        where: {
          vendedorId,
          ...(aliadoScopeId
            ? {
                sede: {
                  aliadoId: aliadoScopeId,
                },
              }
            : {}),
        },
        data: { activo: false },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Usuario eliminado correctamente",
      ...(await loadAdminSellersPayload(aliadoScopeId, canManageApprovalAnalysts(session.user))),
    });
  } catch (error) {
    console.error("ERROR ELIMINANDO VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo eliminar el usuario" },
      { status: 500 }
    );
  }
}
