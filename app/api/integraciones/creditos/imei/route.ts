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
    process.env.FINSERPAY_PUBLIC_API_TOKEN ||
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

function isoDate(value: Date | null | undefined) {
  if (!value) {
    return null;
  }

  return value.toISOString().slice(0, 10);
}

function isoDateTime(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function text(value: string | null | undefined) {
  const clean = String(value || "").trim();
  return clean || null;
}

function extractFamilyReferences(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null) {
    return [];
  }

  const root = snapshot as Record<string, unknown>;
  const cliente =
    typeof root.cliente === "object" && root.cliente !== null
      ? (root.cliente as Record<string, unknown>)
      : null;
  const references = Array.isArray(cliente?.referenciasFamiliares)
    ? cliente.referenciasFamiliares
    : [];

  return references
    .map((item, index) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }

      const record = item as Record<string, unknown>;
      const nombre = typeof record.nombre === "string" ? record.nombre.trim() : "";
      const parentesco =
        typeof record.parentesco === "string" ? record.parentesco.trim() : "";
      const telefono =
        typeof record.telefono === "string" ? record.telefono.trim() : "";

      if (!nombre && !parentesco && !telefono) {
        return null;
      }

      return {
        numero: index + 1,
        nombre: nombre || null,
        parentesco: parentesco || null,
        telefono: telefono || null,
        whatsapp: telefono || null,
      };
    })
    .filter(
      (
        item
      ): item is {
        numero: number;
        nombre: string | null;
        parentesco: string | null;
        telefono: string | null;
        whatsapp: string | null;
      } => Boolean(item)
    )
    .slice(0, 2);
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
        clienteNombre: true,
        clientePrimerNombre: true,
        clientePrimerApellido: true,
        clienteTipoDocumento: true,
        clienteDocumento: true,
        clienteTelefono: true,
        clienteCorreo: true,
        clienteDireccion: true,
        clienteDepartamento: true,
        clienteCiudad: true,
        clienteGenero: true,
        clienteFechaNacimiento: true,
        clienteFechaExpedicion: true,
        imei: true,
        deviceUid: true,
        referenciaEquipo: true,
        equipoMarca: true,
        equipoModelo: true,
        valorEquipoTotal: true,
        montoCredito: true,
        saldoBaseFinanciado: true,
        cuotaInicial: true,
        valorCuota: true,
        plazoMeses: true,
        frecuenciaPago: true,
        referenciaPago: true,
        fechaCredito: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        estado: true,
        deliverableReady: true,
        contratoSnapshot: true,
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
    const frecuenciaPagoLabel = getPaymentFrequencyLabel(credit.frecuenciaPago);
    const referenciaEquipo =
      credit.referenciaEquipo ||
      [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" ");
    const referenciasFamiliares = extractFamilyReferences(
      credit.contratoSnapshot
    );
    const valorCredito = money(Number(credit.saldoBaseFinanciado || 0));
    const totalAPagar = money(Number(credit.montoCredito || 0));
    const valorCuota = money(Number(credit.valorCuota || 0));
    const cuotas = Number(credit.plazoMeses || 0);
    const plazo = cuotas;

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
        cliente: {
          nombre: text(credit.clienteNombre),
          primerNombre: text(credit.clientePrimerNombre),
          primerApellido: text(credit.clientePrimerApellido),
          tipoDocumento: text(credit.clienteTipoDocumento),
          cedula: text(credit.clienteDocumento),
          documento: text(credit.clienteDocumento),
          correo: text(credit.clienteCorreo),
          telefono: text(credit.clienteTelefono),
          whatsapp: text(credit.clienteTelefono),
          direccion: text(credit.clienteDireccion),
          departamento: text(credit.clienteDepartamento),
          ciudad: text(credit.clienteCiudad),
          genero: text(credit.clienteGenero),
          fechaNacimiento: isoDate(credit.clienteFechaNacimiento),
          fechaExpedicion: isoDate(credit.clienteFechaExpedicion),
        },
        equipo: {
          marca: text(credit.equipoMarca),
          modelo: text(credit.equipoModelo),
          referencia: referenciaEquipo || null,
          imei: credit.imei,
          deviceUid: credit.deviceUid,
        },
        financiacion: {
          valorCredito,
          valorEquipo: money(Number(credit.valorEquipoTotal || 0)),
          cuotaInicial: money(Number(credit.cuotaInicial || 0)),
          totalAPagar,
          saldoPendiente: money(plan.saldoPendiente),
          valorCuota,
          cuotas,
          plazo,
          plazoCuotas: cuotas,
          frecuenciaPago: credit.frecuenciaPago,
          frecuenciaPagoLabel,
          cuotasPagadas: plan.paidCount,
          cuotasPendientes: plan.pendingCount,
          estadoPago: plan.estadoPago,
          fechaApertura: isoDateTime(credit.fechaCredito),
          fechaPrimerPago: isoDateTime(credit.fechaPrimerPago),
          fechaProximoPago: isoDateTime(credit.fechaProximoPago),
          referenciaPago: text(credit.referenciaPago),
        },
        referenciasFamiliares,
        referencias: referenciasFamiliares,
        referenciaEquipo,
        valorCredito,
        valorCreditoActivo: totalAPagar,
        valorFinanciadoBase: valorCredito,
        totalAPagar,
        saldoPendiente: money(plan.saldoPendiente),
        valorCuota,
        frecuenciaPago: credit.frecuenciaPago,
        frecuenciaPagoLabel,
        cuotasTotales: cuotas,
        plazo,
        plazoCuotas: cuotas,
        cuotasPagadas: plan.paidCount,
        cuotasPendientes: plan.pendingCount,
        estadoPago: plan.estadoPago,
        fechaCredito: credit.fechaCredito.toISOString(),
        sede: {
          id: credit.sede.id,
          nombre: credit.sede.nombre,
          aliado: credit.sede.aliado
            ? {
                id: credit.sede.aliado.id,
                nombre: credit.sede.aliado.nombre,
                codigo: credit.sede.aliado.codigo,
              }
            : null,
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
