import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { sanitizeSearch, sanitizeText } from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { canOperateSolicitud } from "@/lib/solicitud-operation-access";
import { SolicitudCanonicalMutationError } from "@/lib/solicitudes";
import { isFirmaSeguroSuccessfulStatus } from "@/lib/firmaseguro-status";
import { ensureFirmaSeguroSchema } from "@/lib/firmaseguro-storage";
import { ensureVeriffSchema } from "@/lib/veriff-storage";
import {
  ActiveSolicitudConflictError,
  desistSolicitud,
  desistSolicitudAsCentralAdmin,
  expireStaleSolicitudes,
  getActiveSolicitudCreditContext,
  saveSolicitudDraft,
} from "@/lib/solicitudes-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DRAFT_PAYLOAD_BYTES = 12_000_000;
const DRAFT_REQUIRES_DATACREDITO_CODE =
  "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO";
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
  payloadScope?: unknown;
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
  plataforma: string | null;
  dataCreditoAssessmentId: string | null;
  veriffValidationId: number | null;
  veriffStatus: string | null;
  veriffDecision: string | null;
  firmaStatus: string | null;
  firmaProcessUuid: string | null;
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
  const payload = JSON.parse(json) as DraftPayload;
  // El enrolamiento iPhone es controlado exclusivamente por la revisión
  // autoritativa del analista; nunca se acepta desde el navegador del asesor.
  delete payload.iphoneEnrolamientoVerificado;
  delete payload.iphoneEnrolamientoConfirmadoAt;
  delete payload.iphoneEnrollmentReview;
  delete payload.iphoneEnrollmentReviewId;
  return payload;
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
  const canonicalAssessmentId = String(row.dataCreditoAssessmentId || "").trim();
  const canonicalPlatform = String(row.plataforma || "").trim().toUpperCase();
  const canonicalVeriffValidationId = Number(row.veriffValidationId || 0);
  const payloadStep = clampStep(payload.wizardStep);
  const firmaStep = row.firmaProcessUuid
    ? isFirmaSeguroSuccessfulStatus(row.firmaStatus)
      ? 5
      : 4
    : 1;
  const canonicalStep = Math.max(clampStep(row.currentStep), payloadStep, firmaStep);
  const serializedPayload: DraftPayload = {
    ...payload,
    wizardStep: canonicalStep,
    ...(canonicalAssessmentId
      ? { dataCreditoAssessmentId: canonicalAssessmentId }
      : {}),
    ...(canonicalPlatform === "ANDROID" || canonicalPlatform === "IPHONE"
      ? { plataformaDispositivo: canonicalPlatform }
      : {}),
    ...(Number.isInteger(canonicalVeriffValidationId) &&
    canonicalVeriffValidationId > 0
      ? { veriffValidationId: canonicalVeriffValidationId }
      : {}),
  };

  return {
    id: row.id,
    estado: row.estado,
    currentStep: canonicalStep,
    clienteNombre: row.clienteNombre,
    clienteDocumento: row.clienteDocumento,
    clienteTelefono: row.clienteTelefono,
    imei: row.imei,
    payload: serializedPayload,
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
  if (access.seller?.tipoPerfil === "SUPERVISOR") {
    values.push(access.seller.sedeId || -1);
    where.push(`d."sedeId" = $${values.length}`);
  } else {
    values.push(access.user.aliadoId || -1);
    where.push(`s."aliadoId" = $${values.length}`);
  }
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
        d."clienteTelefono", d."imei", d."plataforma", d."dataCreditoAssessmentId",
        latest_veriff."id" AS "veriffValidationId",
        latest_veriff."status" AS "veriffStatus",
        latest_veriff."decision" AS "veriffDecision",
        latest_firma."status" AS "firmaStatus",
        latest_firma."processUuid" AS "firmaProcessUuid",
        ${payload} AS "payload",
        d."createdAt", d."updatedAt", d."closedAt",
        u."nombre" AS "usuarioNombre", u."usuario" AS "usuarioLogin",
        v."nombre" AS "vendedorNombre", v."documento" AS "vendedorDocumento",
        s."nombre" AS "sedeNombre"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      LEFT JOIN LATERAL (
        SELECT validation."id", validation."status", validation."decision"
        FROM "VeriffIdentityValidation" validation
        WHERE validation."draftId" = d."id"
        ORDER BY validation."id" DESC
        LIMIT 1
      ) latest_veriff ON TRUE
      LEFT JOIN LATERAL (
        SELECT process."status", process."processUuid"
        FROM "FirmaSeguroProcess" process
        WHERE process."draftId" = d."id"
          AND process."supersededAt" IS NULL
        ORDER BY process."createdAt" DESC, process."id" DESC
        LIMIT 1
      ) latest_firma ON TRUE
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
    if (!access.admin && access.seller?.tipoPerfil !== "VENDEDOR") {
      return NextResponse.json(
        { error: "Solo el asesor titular o un administrador autorizado puede consultar solicitudes" },
        { status: 403 }
      );
    }
    await Promise.all([
      expireStaleSolicitudes(),
      ensureVeriffSchema(),
      ensureFirmaSeguroSchema(),
    ]);

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
    if (!access.central && access.seller?.tipoPerfil !== "VENDEDOR") {
      return NextResponse.json(
        { error: "Solo el asesor titular o el administrador central puede guardar esta solicitud" },
        { status: 403 }
      );
    }
    await Promise.all([
      expireStaleSolicitudes(),
      ensureVeriffSchema(),
      ensureFirmaSeguroSchema(),
    ]);
    const body = (await req.json().catch(() => ({}))) as SaveDraftBody;
    const payload = normalizePayload(body.payload);
    const payloadScope =
      sanitizeText(body.payloadScope).toUpperCase() === "DELIVERY_EVIDENCE"
        ? "DELIVERY_EVIDENCE"
        : "FULL";
    const fields = extractDraftFields(payload);
    const draftId = parsePositiveId(body.id);
    const existingDraft = draftId
      ? await getActiveSolicitudCreditContext(draftId)
      : null;
    const canOperateExistingDraft =
      !draftId ||
      canOperateSolicitud({
        central: access.central,
        seller: access.seller,
        viewerAllyId: access.user.aliadoId,
        owner: existingDraft,
      });
    if (!canOperateExistingDraft) {
      return NextResponse.json({ error: "Solicitud no autorizada" }, { status: 403 });
    }
    const owner = existingDraft || {
      usuarioId: access.user.id,
      vendedorId: access.seller?.id || null,
      sedeId: access.user.sedeId,
    };
    const saved = await saveSolicitudDraft({
      id: draftId,
      usuarioId: owner.usuarioId,
      vendedorId: owner.vendedorId,
      sedeId: owner.sedeId,
      currentStep: clampStep(body.currentStep),
      clienteNombre: fields.clienteNombre,
      clienteDocumento: fields.clienteDocumento,
      clienteTelefono: fields.clienteTelefono,
      imei: fields.imei,
      plataforma: sanitizeText(payload.plataformaDispositivo),
      dataCreditoAssessmentId: sanitizeText(payload.dataCreditoAssessmentId),
      payload,
      payloadScope,
    });
    const rows = await readDrafts(`d."id" = $1`, [saved.id], 1, true);
    if (!rows[0]) throw new Error("No se pudo leer el borrador guardado");
    return NextResponse.json({ ok: true, item: serializeDraft(rows[0]) });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === DRAFT_REQUIRES_DATACREDITO_CODE
    ) {
      return NextResponse.json(
        {
          error:
            "La solicitud se crea únicamente después de iniciar la consulta de DataCrédito.",
          code: DRAFT_REQUIRES_DATACREDITO_CODE,
        },
        { status: 409 }
      );
    }
    if (
      error instanceof ActiveSolicitudConflictError ||
      error instanceof SolicitudCanonicalMutationError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("ERROR GUARDANDO BORRADOR:", error);
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
    await expireStaleSolicitudes();
    const body = (await req.json().catch(() => ({}))) as SaveDraftBody;
    const id = parsePositiveId(body.id);
    if (!id) return NextResponse.json({ error: "Borrador invalido" }, { status: 400 });

    if (sanitizeText(body.action).toUpperCase() === "DESISTIR") {
      if (access.central) {
        const result = await desistSolicitudAsCentralAdmin({
          solicitudId: id,
          userId: access.user.id,
        });
        return NextResponse.json(
          {
            ok: result.changed,
            identityReleased: result.identityReleased,
          },
          { status: result.changed ? 200 : 409 }
        );
      }
      if (access.seller?.tipoPerfil !== "VENDEDOR") {
        return NextResponse.json({ error: "Accion no autorizada" }, { status: 403 });
      }
      const result = await desistSolicitud({
        solicitudId: id,
        userId: access.user.id,
        sellerId: access.seller.id,
        aliadoId: access.user.aliadoId || -1,
      });
      return NextResponse.json(
        {
          ok: result.changed,
          identityReleased: result.identityReleased,
        },
        { status: result.changed ? 200 : 409 }
      );
    }

    return NextResponse.json(
      {
        error: "La solicitud solo se finaliza al crear el credito de forma atomica.",
        code: "SOLICITUD_FINALIZACION_ATOMICA_REQUERIDA",
      },
      { status: 405 }
    );
  } catch (error) {
    console.error("ERROR ACTUALIZANDO BORRADOR:", error);
    return NextResponse.json({ error: "No se pudo actualizar el borrador" }, { status: 500 });
  }
}
