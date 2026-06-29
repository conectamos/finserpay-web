import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  calculateCreditCharges,
  calculateFinancedBalance,
  calculateRequiredInitialPaymentByPlatform,
  DEFAULT_CREDIT_INSTALLMENTS,
  DEFAULT_PAYMENT_FREQUENCY,
  generateCreditFolio,
  generatePaymentReference,
  getDefaultFirstPaymentDateObject,
  isIphoneCreditPlatform,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizePaymentFrequency,
  sanitizeDeviceValue,
  sanitizeImageDataUrl,
  sanitizeText,
  toNumber,
  validateIphoneInstallmentLimit,
} from "@/lib/credit-factory";
import { getEffectiveCreditSettings } from "@/lib/credit-settings";
import { findEquipmentCatalogItem } from "@/lib/equipment-catalog";
import { FirmaSeguroApiError } from "@/lib/firmaseguro";
import {
  createFirmaSeguroProcessForDraft,
  getLatestFirmaSeguroProcessForDraft,
  refreshFirmaSeguroProcess,
  serializeFirmaSeguroProcess,
} from "@/lib/firmaseguro-credit";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftPayload = Record<string, unknown>;

type DraftRow = {
  id: number;
  estado: string;
  usuarioId: number;
  vendedorId: number | null;
  sedeId: number;
  currentStep: number;
  payload: unknown;
  usuarioNombre: string | null;
  usuarioLogin: string | null;
  vendedorNombre: string | null;
  vendedorDocumento: string | null;
  vendedorTelefono: string | null;
  vendedorEmail: string | null;
  sedeNombre: string | null;
  sedeCodigo: string | null;
  sedeAliadoId: number | null;
};

class CreditValidationError extends Error {
  status = 400;
}

let draftTableReady: Promise<void> | null = null;

function parseDraftId(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function payloadObject(value: unknown): DraftPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DraftPayload)
    : {};
}

function toValidDate(value: unknown, fallback: Date) {
  const text = sanitizeText(value);
  if (!text) {
    return fallback;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function ensureDraftTable() {
  if (!draftTableReady) {
    draftTableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "CreditoBorrador" (
          "id" SERIAL PRIMARY KEY,
          "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
          "usuarioId" INTEGER NOT NULL,
          "vendedorId" INTEGER,
          "sedeId" INTEGER NOT NULL,
          "currentStep" INTEGER NOT NULL DEFAULT 1,
          "clienteNombre" TEXT,
          "clienteDocumento" TEXT,
          "clienteTelefono" TEXT,
          "imei" TEXT,
          "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "closedAt" TIMESTAMPTZ
        )
      `);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "CreditoBorrador_sede_estado_idx" ON "CreditoBorrador" ("sedeId", "estado")`
      );
    })();
  }

  await draftTableReady;
}

async function readAuthorizedDraft(draftId: number) {
  const user = await getSessionUser();

  if (!user) {
    return { ok: false as const, status: 401, error: "No autenticado" };
  }

  const admin = isAdminRole(user.rolNombre);
  const sellerSession = admin ? null : await getSellerSessionUser(user);

  if (!admin && !sellerSession) {
    return {
      ok: false as const,
      status: 403,
      error: "Debes abrir primero el perfil del vendedor",
    };
  }

  await ensureDraftTable();

  const where = [`d."id" = $1`, `d."estado" = 'ABIERTO'`];
  const values: unknown[] = [draftId];

  if (!admin) {
    values.push(user.sedeId);
    where.push(`d."sedeId" = $${values.length}`);

    if (sellerSession?.tipoPerfil !== "SUPERVISOR") {
      values.push(sellerSession?.id || 0);
      where.push(`d."vendedorId" = $${values.length}`);
    }
  }

  const rows = await prisma.$queryRawUnsafe<DraftRow[]>(
    `
      SELECT
        d.*,
        u."nombre" AS "usuarioNombre",
        u."usuario" AS "usuarioLogin",
        v."nombre" AS "vendedorNombre",
        v."documento" AS "vendedorDocumento",
        v."telefono" AS "vendedorTelefono",
        v."email" AS "vendedorEmail",
        s."nombre" AS "sedeNombre",
        s."codigo" AS "sedeCodigo",
        s."aliadoId" AS "sedeAliadoId"
      FROM "CreditoBorrador" d
      LEFT JOIN "Usuario" u ON u."id" = d."usuarioId"
      LEFT JOIN "Vendedor" v ON v."id" = d."vendedorId"
      LEFT JOIN "Sede" s ON s."id" = d."sedeId"
      WHERE ${where.join(" AND ")}
      LIMIT 1
    `,
    ...values
  );

  const row = rows[0];
  if (!row) {
    return { ok: false as const, status: 404, error: "Borrador no encontrado" };
  }

  return { ok: true as const, row };
}

async function buildDraftCredit(row: DraftRow): Promise<CreditForFirmaSeguroPdf> {
  const payload = payloadObject(row.payload);
  const clientePrimerNombre = sanitizeText(payload.clientePrimerNombre);
  const clientePrimerApellido = sanitizeText(payload.clientePrimerApellido);
  const clienteNombre =
    sanitizeText(payload.clienteNombre) ||
    [clientePrimerNombre, clientePrimerApellido].filter(Boolean).join(" ");
  const clienteDocumento = sanitizeText(payload.clienteDocumento);
  const clienteTelefono = sanitizeText(payload.clienteTelefono);
  const clienteCorreo = sanitizeText(payload.clienteCorreo);
  const clienteDireccion = sanitizeText(payload.clienteDireccion);
  const equipoMarca = sanitizeText(payload.equipoMarca);
  const equipoModelo = sanitizeText(payload.equipoModelo);
  const contratoFotoDataUrl = sanitizeImageDataUrl(
    payload.contratoSelfieDataUrl || payload.contratoFotoDataUrl
  );
  const contratoCedulaFrenteDataUrl = sanitizeImageDataUrl(
    payload.contratoCedulaFrenteDataUrl || payload.cedulaFrenteDataUrl
  );
  const contratoCedulaRespaldoDataUrl = sanitizeImageDataUrl(
    payload.contratoCedulaRespaldoDataUrl || payload.cedulaRespaldoDataUrl
  );
  const referenciaEquipo =
    sanitizeText(payload.referenciaEquipo) ||
    [equipoMarca, equipoModelo].filter(Boolean).join(" ");
  const imei = sanitizeDeviceValue(payload.imei || payload.deviceUid)
    .replace(/\D/g, "")
    .slice(0, 15);
  const plataformaDispositivo = isIphoneCreditPlatform(payload.plataformaDispositivo)
    ? "IPHONE"
    : "ANDROID";
  const isIphoneCredit = plataformaDispositivo === "IPHONE";
  const valorEquipoTotalInput = toNumber(payload.valorEquipoTotal);
  const catalogItem =
    equipoMarca && equipoModelo
      ? await findEquipmentCatalogItem({ marca: equipoMarca, modelo: equipoModelo })
      : null;
  const precioBaseVentaCatalogo = catalogItem?.activo
    ? catalogItem.precioBaseVenta
    : null;
  const effectiveCreditSettings = await getEffectiveCreditSettings(
    clienteDocumento,
    plataformaDispositivo
  );
  const creditSettings = effectiveCreditSettings.settings;
  const cuotaInicialMinima = calculateRequiredInitialPaymentByPlatform({
    valorTotalEquipo: valorEquipoTotalInput,
    precioBaseVenta: precioBaseVentaCatalogo,
    initialPaymentPercentage: creditSettings.cuotaInicialPorcentaje,
    platform: plataformaDispositivo,
    iphoneMaxFinancedAmount: creditSettings.iphoneTopeFinanciado,
  });
  const cuotaInicialInput = toNumber(payload.cuotaInicial);
  const cuotaInicial =
    cuotaInicialInput > 0
      ? Math.max(cuotaInicialMinima, cuotaInicialInput)
      : cuotaInicialMinima;
  const plazoMaximoCuotas = normalizeCreditInstallmentLimit(
    creditSettings.plazoMaximoCuotas
  );
  const plazoMeses = normalizeCreditInstallments(
    toNumber(payload.plazoMeses),
    creditSettings.plazoCuotas || DEFAULT_CREDIT_INSTALLMENTS,
    plazoMaximoCuotas
  );
  const frecuenciaPago = isIphoneCredit
    ? DEFAULT_PAYMENT_FREQUENCY
    : normalizePaymentFrequency(payload.frecuenciaPago || creditSettings.frecuenciaPago);
  const fechaCredito = new Date();
  const defaultFirstPaymentDate = getDefaultFirstPaymentDateObject(
    frecuenciaPago,
    fechaCredito
  );
  const fechaPrimerPago = isIphoneCredit
    ? defaultFirstPaymentDate
    : toValidDate(payload.fechaPrimerPago, defaultFirstPaymentDate);
  const saldoBaseFinanciado = calculateFinancedBalance(
    valorEquipoTotalInput,
    cuotaInicial
  );
  const financialPlan = calculateCreditCharges({
    saldoBaseFinanciado,
    cuotas: plazoMeses,
    tasaInteresEa: creditSettings.tasaInteresEa,
    fianzaPorcentaje: creditSettings.fianzaPorcentaje,
    frecuenciaPago,
  });
  const iphoneInstallmentLimit = validateIphoneInstallmentLimit({
    platform: plataformaDispositivo,
    valorCuota: financialPlan.valorCuota,
    iphoneMaxInstallmentValue: creditSettings.iphoneTopeCuota,
  });

  if (iphoneInstallmentLimit.exceeded) {
    throw new CreditValidationError(iphoneInstallmentLimit.message);
  }

  const folio = sanitizeText(payload.firmaSeguroDraftFolio) || generateCreditFolio();
  const referenciaPago = generatePaymentReference(folio, clienteDocumento);

  return {
    folio,
    contratoSnapshot: {
      borradorId: row.id,
      origen: "BORRADOR_FIRMASEGURO",
    },
    clienteTipoDocumento: sanitizeText(payload.clienteTipoDocumento) || null,
    clienteNombre,
    clientePrimerNombre,
    clientePrimerApellido,
    clienteDocumento,
    clienteTelefono,
    clienteCorreo,
    clienteDireccion,
    referenciaEquipo,
    equipoMarca,
    equipoModelo,
    imei,
    deviceUid: imei,
    valorEquipoTotal: valorEquipoTotalInput,
    montoCredito: financialPlan.montoCreditoTotal,
    cuotaInicial,
    valorCuota: financialPlan.valorCuota,
    plazoMeses,
    frecuenciaPago,
    fechaPrimerPago,
    fechaCredito,
    referenciaPago,
    valorFianza: financialPlan.valorFianza,
    contratoIp: sanitizeText(payload.contratoIp) || null,
    contratoFotoDataUrl,
    contratoSelfieDataUrl: contratoFotoDataUrl,
    contratoCedulaFrenteDataUrl,
    contratoCedulaRespaldoDataUrl,
    usuario: {
      nombre: row.usuarioNombre || "Usuario FINSER PAY",
      usuario: row.usuarioLogin || null,
    },
    vendedor: row.vendedorId
      ? {
          nombre: row.vendedorNombre,
          documento: row.vendedorDocumento,
          telefono: row.vendedorTelefono,
          email: row.vendedorEmail,
        }
      : null,
    sede: {
      nombre: row.sedeNombre || "Sede",
      codigo: row.sedeCodigo,
      aliadoId: row.sedeAliadoId,
    },
  };
}

function firmaSeguroErrorResponse(error: unknown) {
  if (error instanceof CreditValidationError) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: error.status }
    );
  }

  if (error instanceof FirmaSeguroApiError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        detail: error.detail,
      },
      { status: error.status || 500 }
    );
  }

  const message =
    error instanceof Error
      ? error.message
      : "No se pudo procesar la solicitud de FirmaSeguro";

  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);

    if (!draftId) {
      return NextResponse.json(
        { ok: false, error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const authorized = await readAuthorizedDraft(draftId);
    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const current = await getLatestFirmaSeguroProcessForDraft(draftId);
    if (!current) {
      return NextResponse.json({ ok: true, process: null });
    }

    const url = new URL(request.url);
    const shouldRefresh = url.searchParams.get("refresh") === "1";
    const process = shouldRefresh ? await refreshFirmaSeguroProcess(current) : current;

    return NextResponse.json({
      ok: true,
      process: serializeFirmaSeguroProcess(process),
    });
  } catch (error) {
    return firmaSeguroErrorResponse(error);
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const draftId = parseDraftId(params.id);

    if (!draftId) {
      return NextResponse.json(
        { ok: false, error: "Borrador invalido" },
        { status: 400 }
      );
    }

    const authorized = await readAuthorizedDraft(draftId);
    if (!authorized.ok) {
      return NextResponse.json(
        { ok: false, error: authorized.error },
        { status: authorized.status }
      );
    }

    const current = await getLatestFirmaSeguroProcessForDraft(draftId);
    const credit = await buildDraftCredit(authorized.row);
    const draftFolio = current?.draftFolio || credit.folio;
    const payload = {
      ...payloadObject(authorized.row.payload),
      firmaSeguroDraftFolio: draftFolio,
    };

    credit.folio = draftFolio;
    credit.referenciaPago = generatePaymentReference(
      draftFolio,
      credit.clienteDocumento || ""
    );

    await prisma.$executeRawUnsafe(
      `
        UPDATE "CreditoBorrador"
        SET "payload" = $2::jsonb,
            "updatedAt" = NOW()
        WHERE "id" = $1
      `,
      draftId,
      JSON.stringify(payload)
    );

    const process = await createFirmaSeguroProcessForDraft(credit, {
      draftId,
      draftFolio,
      draftPayload: payload,
    });

    return NextResponse.json({
      ok: true,
      process: serializeFirmaSeguroProcess(process),
      message: "Proceso de firma enviado a FirmaSeguro",
    });
  } catch (error) {
    return firmaSeguroErrorResponse(error);
  }
}
