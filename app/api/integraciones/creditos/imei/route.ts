import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  getPaymentFrequencyLabel,
  sanitizeDeviceValue,
} from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH_HEADER_PREFIX = "Bearer ";

function getConfiguredApiKey() {
  return String(
    process.env.FINSERPAY_EXTERNAL_API_KEY ||
      process.env.FINSERPAY_INTEGRATIONS_API_KEY ||
      ""
  ).trim();
}

function getRequestApiKey(req: Request) {
  const authorization = req.headers.get("authorization") || "";

  if (authorization.startsWith(AUTH_HEADER_PREFIX)) {
    return authorization.slice(AUTH_HEADER_PREFIX.length).trim();
  }

  return String(req.headers.get("x-api-key") || "").trim();
}

function apiKeyMatches(received: string, expected: string) {
  if (!received || !expected) {
    return false;
  }

  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function money(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export async function GET(req: Request) {
  try {
    const configuredApiKey = getConfiguredApiKey();

    if (!configuredApiKey) {
      return NextResponse.json(
        { ok: false, error: "API de integraciones no configurada" },
        { status: 503 }
      );
    }

    if (!apiKeyMatches(getRequestApiKey(req), configuredApiKey)) {
      return NextResponse.json(
        { ok: false, error: "No autorizado" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const imei = sanitizeDeviceValue(searchParams.get("imei")).replace(/\D/g, "");

    if (!/^\d{15}$/.test(imei)) {
      return NextResponse.json(
        { ok: false, error: "IMEI invalido. Debe tener 15 digitos." },
        { status: 400 }
      );
    }

    await ensureCreditAbonoAuditColumns();

    const candidates = await prisma.credito.findMany({
      where: {
        OR: [{ imei }, { deviceUid: imei }],
        estado: {
          notIn: ["ANULADO", "PAZ_Y_SALVO"],
        },
      },
      select: {
        id: true,
        folio: true,
        imei: true,
        deviceUid: true,
        referenciaEquipo: true,
        equipoMarca: true,
        equipoModelo: true,
        montoCredito: true,
        saldoBaseFinanciado: true,
        valorCuota: true,
        plazoMeses: true,
        frecuenciaPago: true,
        fechaCredito: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        estado: true,
        deliverableReady: true,
        sede: {
          select: {
            id: true,
            nombre: true,
          },
        },
        abonos: {
          where: {
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            valor: true,
            fechaAbono: true,
          },
          orderBy: {
            fechaAbono: "asc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 5,
    });

    const activeCredits = candidates
      .map((credit) => {
        const plan = buildCreditPaymentPlan({
          montoCredito: Number(credit.montoCredito || 0),
          valorCuota: Number(credit.valorCuota || 0),
          plazoMeses: Number(credit.plazoMeses || 1),
          frecuenciaPago: credit.frecuenciaPago,
          fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
          abonos: credit.abonos.map((item) => ({
            valor: Number(item.valor || 0),
            fechaAbono: item.fechaAbono,
          })),
        });

        return { credit, plan };
      })
      .filter((item) => item.plan.saldoPendiente > 0);

    const active = activeCredits[0];

    if (!active) {
      return NextResponse.json(
        { ok: false, active: false, error: "No hay credito activo para este IMEI" },
        { status: 404 }
      );
    }

    const { credit, plan } = active;
    const nextInstallment = plan.nextInstallment;
    const referenciaEquipo =
      credit.referenciaEquipo ||
      [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" ");

    return NextResponse.json({
      ok: true,
      active: true,
      imei: credit.imei,
      deviceUid: credit.deviceUid,
      credit: {
        id: credit.id,
        folio: credit.folio,
        estado: credit.estado,
        entregable: credit.deliverableReady,
        referenciaEquipo,
        valorCreditoActivo: money(Number(credit.montoCredito || 0)),
        valorFinanciadoBase: money(Number(credit.saldoBaseFinanciado || 0)),
        saldoPendiente: money(plan.saldoPendiente),
        valorCuota: money(Number(credit.valorCuota || 0)),
        frecuenciaPago: credit.frecuenciaPago,
        frecuenciaPagoLabel: getPaymentFrequencyLabel(credit.frecuenciaPago),
        cuotasTotales: Number(credit.plazoMeses || 0),
        cuotasPagadas: plan.paidCount,
        cuotasPendientes: plan.pendingCount,
        estadoPago: plan.estadoPago,
        fechaCredito: credit.fechaCredito.toISOString(),
        sede: {
          id: credit.sede.id,
          nombre: credit.sede.nombre,
        },
        proximaCuota: nextInstallment
          ? {
              numero: nextInstallment.numero,
              fechaVencimiento: nextInstallment.fechaVencimiento,
              valor: money(nextInstallment.saldoPendiente),
              estado: nextInstallment.estaEnMora ? "MORA" : nextInstallment.estado,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("ERROR API INTEGRACION CREDITO IMEI:", error);
    return NextResponse.json(
      { ok: false, error: "No se pudo consultar el credito por IMEI" },
      { status: 500 }
    );
  }
}
