import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { sanitizeSearch, sanitizeText } from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";
import {
  ActiveSolicitudConflictError,
  desistSolicitud,
  ensureSolicitudSchema,
  saveSolicitudDraft,
} from "@/lib/solicitudes-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DRAFT_PAYLOAD_BYTES = 12_000_000;
const PRUNED_DRAFT_MEDIA_FIELDS = new Set([
  "contratoFirmaDataUrl",
  "firmaDataUrl",
  "contratoVideoAprobacionDataUrl",
]);

type DraftPayload = Record<string, unknown>;
type SaveDraftBody = {
  id?: unknown;
  currentStep?: unknown;
  payload?: unknown;
  estado?: unknown;
  action?: unknown;
  creditoId?: unknown;
};

type DraftRow = {
  id: number;
  estado: string;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  currentStep: number;
  clienteNombre: string | null;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string | null;
  payload: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  closedAt: Date | string | null;
  usuarioNombre: string | null;
  usuarioLogin: string | null;
  vendedorNombre: string | null;
  vendedorDocumento: string | null;
  sedeNombre: string | null;
};

function parsePositiveId(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampStep(value: unknown) {
  const parsed = Math.trunc(Number(value || 1));
  return Math.max(1, Math.min(5, Number.isFinite(parsed) ? parsed : 1));
}

function parseTake(value: unknown) {
  const parsed = Math.trunc(Number(value || 12));
  return Math.max(1, Math.min(30, Number.isFinite(parsed) ? parsed : 12));
}

function toLimitedText(value: unknown, maxLength = 180) {
  const text = sanitizeText(value).slice(0, maxLength);
  return text || null;
}

function toDateIso(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pruneDraftPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneDraftPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PRUNED_DRAFT_MEDIA_FIELDS.has(key))
      .map(([key, item]) => [key, pruneDraftPayload(item)])
  );
}

function normalizePayload(value: unknown): DraftPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const json = JSON.stringify(pruneDraftPayload(value));
  if (Buffer.byteLength(json, "utf8") > MAX_DRAFT_PAYLOAD_BYTES) {
    throw new Error("Las evidencias del borrador son demasiado grandes para guardarlas automaticamente");
  }
  return JSON.parse(json) as DraftPayload;
}

function extractDraftFields(payload: DraftPayload) {
  const firstName = toLimitedText(payload.clientePrimerNombre, 90);
  const lastName = toLimitedText(payload.clientePrimerApellido, 90);
  return {
    clienteNombre:
      toLimitedText(payload.clienteNombre, 180) ||
      [firstName, lastName].filter(Boolean).join(" ").trim() ||
      null,
    clienteDocumento: toLimitedText(payload.clienteDocumento, 60),
    clienteTelefono: toLimitedText(payload.clienteTelefono, 60),
    imei: toLimitedText(payload.imei, 60),
  };
}

function serializeDraft(row: DraftRow) {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as DraftPayload)
      : {};
  return {
    id: row.id,
    estado: row.estado,
    currentStep: row.currentStep,
    clienteNombre: row.clienteNombre,
    clienteDocumento: row.clienteDocumento,
    clienteTelefono: row.clienteTelefono,
    imei: row.imei,
    payload,
    createdAt: toDateIso(row.createdAt),
    updatedAt: toDateIso(row.updatedAt),
    closedAt: toDateIso(row.closedAt),
    usuario: {
      id: row.usuarioId,
      nombre: row.usuarioNombre || "Usuario",
      usuario: row.usuarioLogin || "",
    },
    vendedor: row.vendedorId
      ? {
          id: row.vendedorId,
          nombre: row.vendedorNombre || "Asesor",
          documento: row.vendedorDocumento,
        }
      : null,
    sede: { id: row.sedeId, nombre: row.sedeNombre || "Sede" },
  };
}

async function getAccess() {
  const user = await getSessionUser();
  if (!user) return null;
  const admin = isAdminRole(user.rolNombre);
  const seller = admin ? null : await getSellerSessionUser(user);
  return {
    user,
    admin,
    central: admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo),
    seller,
  };
}

function addReadScope(
  where: string[],
  values: unknown[],
  access: NonNullable<Awaited<ReturnType<typeof getAccess>>>,
  ownerOnly: boolean
) {
  if (access.central) return;
  if (access.admin) {
    values.push(access.user.aliadoAccesoId || -1);
    where.push(`s."aliadoId" = $${values.length}`);
    return;
  }
  values.push(access.seller?.sedeId || -1);
  where.push(`d."sedeId" = $${values.length}`);
  if (ownerOnly || access.seller?.tipoPerfil !== "SUPERVISOR") {
    values.push(access.seller?.id || -1);
    where.push(`d."vendedorId" = $${values.length}`);
  }
}

async function readDrafts(
  whereSql: string,
  values: unknown[],
  take: number,
  includeEvidence: boolean
) {
  const payload = includeEvidence
    ? `d."payload"`
    : `d."payload"
        - 'iphoneSelfieCedulaDataUrl' - 'fotoEntregaDataUrl' - 'fotoRemisionDataUrl'
        - 'contratoSelfieDataUrl' - 'contratoFotoDataUrl'
        - 'contratoCedulaFrenteDataUrl' - 'cedulaFrenteDataUrl'
        - 'contratoCedulaRespaldoDataUrl' - 'cedulaRespaldoDataUrl'`;
  return prisma.$queryRawUnsafe<DraftRow[]>(
    `
      SELECT d."id", d."estado", d."usuarioId", d."vendedorId", d."sedeId",
        d."currentStep", d."clienteNombre", d."clienteDocumento",
        d."clienteTelefono", d."imei", ${payload} AS "payload",
        d."createdAt", d."updatedAt", d."closedAt",
        u."nombre" AS "usuarioNombre", u."usuario" AS "usuarioLogin",
        v."nombre" AS "vendedorNombre", v."documento" AS "vendedorDocumento",
        s."nombre" AS "sedeNombre"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE ${whereSql}
      ORDER BY d."updatedAt" DESC
      LIMIT $${values.length + 1}
    `,
    ...values,
    take
  );
}

export async function GET(req: Request) {
  try {
    const access = await getAccess();
    if (!access) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    if (!access.admin && !access.seller) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }
    await ensureSolicitudSchema();

    const params = new URL(req.url).searchParams;
    const id = parsePositiveId(params.get("id"));
    const search = sanitizeSearch(params.get("search"));
    const take = parseTake(params.get("take"));
    const where = [`d."estado" = 'ABIERTO'`];
    const values: unknown[] = [];
    addReadScope(where, values, access, Boolean(id));

    if (id) {
      values.push(id);
      where.push(`d."id" = $${values.length}`);
      const rows = await readDrafts(where.join(" AND "), values, 1, true);
      if (!rows[0]) {
        return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, item: serializeDraft(rows[0]) });
    }

    if (!search) {
      return NextResponse.json({
        ok: true,
        scope: access.central ? "global" : access.admin ? "aliado" : "sede",
        search,
        items: [],
      });
    }
    values.push(`%${search}%`);
    const index = values.length;
    where.push(`(
      d."clienteNombre" ILIKE $${index} OR d."clienteDocumento" ILIKE $${index}
      OR d."clienteTelefono" ILIKE $${index} OR d."imei" ILIKE $${index}
    )`);
    const rows = await readDrafts(where.join(" AND "), values, take, false);
    return NextResponse.json({
      ok: true,
      scope: access.central ? "global" : access.admin ? "aliado" : "sede",
      search,
      items: rows.map(serializeDraft),
    });
  } catch (error) {
    console.error("ERROR LISTANDO BORRADORES:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudieron cargar los borradores" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = await getAccess();
    if (!access) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    if (!access.admin && !access.seller) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }
    const body = (await req.json().catch(() => ({}))) as SaveDraftBody;
    const payload = normalizePayload(body.payload);
    const fields = extractDraftFields(payload);
    const saved = await saveSolicitudDraft({
      id: parsePositiveId(body.id),
      usuarioId: access.user.id,
      vendedorId: access.seller?.id || null,
      sedeId: access.user.sedeId,
      currentStep: clampStep(body.currentStep),
      clienteNombre: fields.clienteNombre,
      clienteDocumento: fields.clienteDocumento,
      clienteTelefono: fields.clienteTelefono,
      imei: fields.imei,
      plataforma: sanitizeText(payload.plataformaDispositivo),
      dataCreditoAssessmentId: sanitizeText(payload.dataCreditoAssessmentId),
      payload,
    });
    const rows = await readDrafts(`d."id" = $1`, [saved.id], 1, true);
    if (!rows[0]) throw new Error("No se pudo leer el borrador guardado");
    return NextResponse.json({ ok: true, item: serializeDraft(rows[0]) });
  } catch (error) {
    console.error("ERROR GUARDANDO BORRADOR:", error);
    if (error instanceof ActiveSolicitudConflictError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    const forbidden = error instanceof Error && error.message === "SOLICITUD_NO_AUTORIZADA";
    return NextResponse.json(
      { error: forbidden ? "Solicitud no autorizada" : "No se pudo guardar el borrador" },
      { status: forbidden ? 403 : 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await getAccess();
    if (!access) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    if (!access.admin && !access.seller) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }
    await ensureSolicitudSchema();
    const body = (await req.json().catch(() => ({}))) as SaveDraftBody;
    const id = parsePositiveId(body.id);
    if (!id) return NextResponse.json({ error: "Borrador invalido" }, { status: 400 });

    if (sanitizeText(body.action).toUpperCase() === "DESISTIR") {
      if (!access.seller || access.seller.tipoPerfil !== "VENDEDOR") {
        return NextResponse.json({ error: "Accion no autorizada" }, { status: 403 });
      }
      const changed = await desistSolicitud({
        solicitudId: id,
        userId: access.user.id,
        sellerId: access.seller.id,
        sedeId: access.seller.sedeId,
      });
      return NextResponse.json({ ok: changed }, { status: changed ? 200 : 409 });
    }

    if (sanitizeText(body.estado).toUpperCase() !== "CERRADO") {
      return NextResponse.json({ error: "Estado invalido" }, { status: 400 });
    }
    const changed = await prisma.$executeRawUnsafe(
      `
        UPDATE "CreditoBorrador"
        SET "estado" = 'CERRADO', "closedReason" = 'FINALIZADA',
          "creditoId" = COALESCE($2, "creditoId"),
          "closedAt" = COALESCE("closedAt", CURRENT_TIMESTAMP),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "estado" = 'ABIERTO'
          AND "usuarioId" = $3 AND "vendedorId" IS NOT DISTINCT FROM $4
          AND "sedeId" = $5
      `,
      id,
      parsePositiveId(body.creditoId),
      access.user.id,
      access.seller?.id || null,
      access.user.sedeId
    );
    if (changed > 0) {
      return NextResponse.json({ ok: true });
    }

    const alreadyFinalized = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `
        SELECT "id"
        FROM "CreditoBorrador"
        WHERE "id" = $1
          AND "estado" = 'CERRADO'
          AND "closedReason" = 'FINALIZADA'
          AND "usuarioId" = $2
          AND "vendedorId" IS NOT DISTINCT FROM $3
          AND "sedeId" = $4
        LIMIT 1
      `,
      id,
      access.user.id,
      access.seller?.id || null,
      access.user.sedeId
    );
    return NextResponse.json(
      { ok: alreadyFinalized.length > 0 },
      { status: alreadyFinalized.length > 0 ? 200 : 409 }
    );
  } catch (error) {
    console.error("ERROR ACTUALIZANDO BORRADOR:", error);
    return NextResponse.json({ error: "No se pudo actualizar el borrador" }, { status: 500 });
  }
}
