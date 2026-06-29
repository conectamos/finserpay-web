import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  getPaymentFrequencyLabel,
  sanitizeText,
} from "@/lib/credit-factory";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

function isAnnulled(value: string | null | undefined) {
  return String(value || "").toUpperCase().includes("ANUL");
}

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatMoney(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function dateFromIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1, 12, 0, 0, 0);

  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function signedDaysFromDueDate(dueDateIso: string, today: Date) {
  const due = dateFromIso(dueDateIso);
  const base = new Date(today);
  base.setHours(12, 0, 0, 0);

  return Math.floor((base.getTime() - due.getTime()) / 86_400_000);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textCell(value: unknown) {
  return `<td style='mso-number-format:"\\@";'>${escapeHtml(value)}</td>`;
}

function moneyCell(value: number) {
  return `<td style='mso-number-format:"#,##0";'>${Math.round(Number(value || 0))}</td>`;
}

function numberCell(value: number) {
  return `<td style='mso-number-format:"0";'>${Math.round(Number(value || 0))}</td>`;
}

function parsePositiveInt(value: unknown) {
  const parsed = Number(String(value ?? "").trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function splitOutstandingBalance(options: {
  montoCredito: number;
  saldoBaseFinanciado: number;
  saldoPendiente: number;
  valorEquipoTotal: number;
  cuotaInicial: number;
  valorFianza: number;
  valorInteres: number;
}) {
  const saldoPendiente = roundMoney(options.saldoPendiente);
  const capitalOriginal =
    Number(options.saldoBaseFinanciado || 0) ||
    Math.max(0, Number(options.valorEquipoTotal || 0) - Number(options.cuotaInicial || 0));
  const fianzaOriginal = Math.max(0, Number(options.valorFianza || 0));
  const interesOriginal = Math.max(0, Number(options.valorInteres || 0));
  const totalOriginal =
    capitalOriginal + fianzaOriginal + interesOriginal ||
    Math.max(0, Number(options.montoCredito || 0));

  if (saldoPendiente <= 0) {
    return {
      saldoCapital: 0,
      saldoFianza: 0,
      saldoIntereses: 0,
    };
  }

  if (totalOriginal <= 0) {
    return {
      saldoCapital: saldoPendiente,
      saldoFianza: 0,
      saldoIntereses: 0,
    };
  }

  const saldoCapital = roundMoney((saldoPendiente * capitalOriginal) / totalOriginal);
  const saldoFianza = roundMoney((saldoPendiente * fianzaOriginal) / totalOriginal);
  const saldoIntereses = roundMoney(
    Math.max(0, saldoPendiente - saldoCapital - saldoFianza)
  );

  return {
    saldoCapital,
    saldoFianza,
    saldoIntereses,
  };
}

function buildWorkbookHtml(rows: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 12px; }
    th { background: #111318; color: #ffffff; font-weight: 700; border: 1px solid #d7dce2; padding: 8px; }
    td { border: 1px solid #d7dce2; padding: 7px; }
  </style>
</head>
<body>
  <table>
    <thead>
      <tr>
        <th>Fecha apertura</th>
        <th>Nombre del cliente</th>
        <th>Cedula</th>
        <th>Telefono del cliente</th>
        <th>IMEI</th>
        <th>Referencia</th>
        <th>Plazo credito</th>
        <th>Frecuencia de pago</th>
        <th>ALIADO</th>
        <th>SEDE</th>
        <th>Fecha proxima cuota a pagar</th>
        <th>Cuotas pendientes</th>
        <th>Valor cuota</th>
        <th>Saldo obligacion</th>
        <th>Saldo capital</th>
        <th>Saldo fianza</th>
        <th>Saldo intereses</th>
        <th>Dias vencidos</th>
        <th>Ultimo pago que ha realizado</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede descargar cartera" },
        { status: 403 }
      );
    }

    await ensureCreditAbonoAuditColumns();

    const { searchParams } = new URL(req.url);
    const requestedAliadoId = parsePositiveInt(searchParams.get("aliadoId"));
    const adminCentral = isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const ownAliadoId = parsePositiveInt(user.aliadoAccesoId);
    const selectedAliadoId = adminCentral ? requestedAliadoId : ownAliadoId;
    const where: Prisma.CreditoWhereInput = {
      estado: {
        not: "ANULADO",
      },
      ...(selectedAliadoId
        ? {
            sede: {
              aliadoId: selectedAliadoId,
            },
          }
        : {}),
    };

    const today = new Date();
    const creditos = await prisma.credito.findMany({
      where,
      include: {
        abonos: {
          where: {
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            fechaAbono: true,
            metodoPago: true,
            valor: true,
          },
          orderBy: {
            fechaAbono: "asc",
          },
        },
        sede: {
          select: {
            nombre: true,
            aliado: {
              select: {
                nombre: true,
              },
            },
          },
        },
      },
      orderBy: {
        fechaCredito: "desc",
      },
    });

    const rows = creditos
      .filter((credito) => !isAnnulled(credito.estado))
      .map((credito) => {
        const plan = buildCreditPaymentPlan({
          montoCredito: Number(credito.montoCredito || 0),
          valorCuota: Number(credito.valorCuota || 0),
          plazoMeses: Number(credito.plazoMeses || 1),
          frecuenciaPago: credito.frecuenciaPago,
          fechaPrimerPago: credito.fechaPrimerPago || credito.fechaProximoPago,
          abonos: credito.abonos.map((abono) => ({
            fechaAbono: abono.fechaAbono,
            valor: Number(abono.valor || 0),
          })),
          today,
        });

        return {
          credito,
          plan,
        };
      })
      .filter(({ plan }) => plan.saldoPendiente > 0)
      .map(({ credito, plan }) => {
        const pendingInstallments = plan.installments.filter(
          (installment) => installment.saldoPendiente > 0
        );
        const signedPendingDays = pendingInstallments.map((installment) =>
          signedDaysFromDueDate(installment.fechaVencimiento, today)
        );
        const positiveDays = signedPendingDays.filter((days) => days > 0);
        const diasVencidos = positiveDays.length
          ? Math.max(...positiveDays)
          : plan.nextInstallment
            ? signedDaysFromDueDate(plan.nextInstallment.fechaVencimiento, today)
            : 0;
        const lastPayment = credito.abonos[credito.abonos.length - 1] || null;
        const balances = splitOutstandingBalance({
          cuotaInicial: Number(credito.cuotaInicial || 0),
          montoCredito: Number(credito.montoCredito || 0),
          saldoBaseFinanciado: Number(credito.saldoBaseFinanciado || 0),
          saldoPendiente: plan.saldoPendiente,
          valorEquipoTotal: Number(credito.valorEquipoTotal || 0),
          valorFianza: Number(credito.valorFianza || 0),
          valorInteres: Number(credito.valorInteres || 0),
        });
        const ultimoPago = lastPayment
          ? [
              formatDate(lastPayment.fechaAbono),
              `$ ${formatMoney(Number(lastPayment.valor || 0))}`,
              sanitizeText(lastPayment.metodoPago),
            ]
              .filter(Boolean)
              .join(" - ")
          : "";
        const referenciaEquipo =
          credito.referenciaEquipo ||
          [credito.equipoMarca, credito.equipoModelo].filter(Boolean).join(" ") ||
          "";

        return `<tr>
          ${textCell(formatDate(credito.fechaCredito))}
          ${textCell(credito.clienteNombre)}
          ${textCell(credito.clienteDocumento || "")}
          ${textCell(credito.clienteTelefono || "")}
          ${textCell(credito.imei || "")}
          ${textCell(referenciaEquipo)}
          ${numberCell(Number(credito.plazoMeses || 0))}
          ${textCell(getPaymentFrequencyLabel(credito.frecuenciaPago))}
          ${textCell(credito.sede.aliado?.nombre || "")}
          ${textCell(credito.sede.nombre)}
          ${textCell(plan.nextInstallment?.fechaVencimiento || "")}
          ${numberCell(plan.pendingCount)}
          ${moneyCell(Number(credito.valorCuota || 0))}
          ${moneyCell(plan.saldoPendiente)}
          ${moneyCell(balances.saldoCapital)}
          ${moneyCell(balances.saldoFianza)}
          ${moneyCell(balances.saldoIntereses)}
          ${numberCell(diasVencidos)}
          ${textCell(ultimoPago)}
        </tr>`;
      })
      .join("");

    const html = buildWorkbookHtml(rows);
    const filename = `cartera-activa-finserpay-${new Date()
      .toISOString()
      .slice(0, 10)}.xls`;

    return new NextResponse(html, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("ERROR EXPORTANDO CARTERA:", error);
    return NextResponse.json(
      { error: "No se pudo descargar la cartera en Excel" },
      { status: 500 }
    );
  }
}
