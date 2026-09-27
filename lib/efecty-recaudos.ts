import crypto from "node:crypto";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  buildEarlyPayoffObservation,
  calculateCreditEarlyPayoff,
  type CreditEarlyPayoffResult,
} from "@/lib/credit-early-payoff";
import {
  consumeEfectyPayoffIntent,
  ensureEfectyPayoffIntentTable,
  findEfectyPayoffIntent,
} from "@/lib/efecty-payoff-intents";
import { resolveNextPaymentDateAfterPayment } from "@/lib/credit-next-payment-date";
import {
  creditCajaDescription,
  resolveCreditState,
} from "@/lib/credit-factory";
import { syncCreditMora } from "@/lib/credit-mora-sync";
import {
  readMassCreditComponents,
  updateMassCreditComponentsForPayoff,
} from "@/lib/mass-credit-financial-components";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  DIGITAL_COLLECTION_CAJA_CONCEPT,
  ensureDigitalCollectionSede,
} from "@/lib/digital-collection-sede";
import prisma from "@/lib/prisma";
import {
  enqueueUnlockForCurrentCredit,
  processDeviceUnlockCommand,
} from "@/lib/device-unlock-queue";

const DEFAULT_REMOTE_DIR = "/Salida";
const DEFAULT_VALID_COMPANIES = ["FINSERPAY"];
const DEFAULT_FILE_LIMIT = 10;
const BOGOTA_TIME_ZONE = "America/Bogota";

type EfectyLine = {
  company: string;
  fields: string[];
  lineNumber: number;
  lineType: string;
  paidAt: Date | null;
  paymentKey: string;
  rawLine: string;
  reference: string;
  value: number;
};

type EfectyImportRow = {
  abonoId: number | null;
  id: number;
  message: string | null;
  status: string;
};

type EfectySyncOptions = {
  dryRun?: boolean;
  fileDate?: string | null;
  filenames?: string[];
  includePreviousFiles?: boolean;
  limitFiles?: number;
};

type EfectyLineResult = {
  abonoId?: number | null;
  action:
    | "APLICADO"
    | "DUPLICADO"
    | "ERROR"
    | "OMITIDO_EMPRESA"
    | "SIN_CREDITO"
    | "VALOR_INVALIDO"
    | "VALOR_SUPERA_SALDO"
    | "REVISION_REQUERIDA"
    | "VISTA_PREVIA";
  creditoId?: number | null;
  empresa: string;
  file: string;
  lineNumber: number;
  message: string;
  referencia: string;
  value: number;
};

type EfectyFileResult = {
  file: string;
  lines: EfectyLineResult[];
};

const PENDING_EFECTY_ACTIONS = new Set<EfectyLineResult["action"]>([
  "REVISION_REQUERIDA",
  "SIN_CREDITO",
  "VALOR_INVALIDO",
  "VALOR_SUPERA_SALDO",
]);

function actionForExistingImport(status: string): EfectyLineResult["action"] {
  return PENDING_EFECTY_ACTIONS.has(status as EfectyLineResult["action"])
    ? status as EfectyLineResult["action"]
    : "DUPLICADO";
}

type SftpConfig = {
  deleteAfterProcess: boolean;
  host: string;
  password?: string;
  port: number;
  privateKey?: string;
  remoteDir: string;
  username: string;
};

function normalizeToken(value: unknown) {
  return String(value || "").trim();
}

function normalizeDigits(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function getBogotaCompactDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: BOGOTA_TIME_ZONE,
    year: "numeric",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}${byType.month}${byType.day}`;
}

function normalizeFileDate(value: unknown) {
  const digits = normalizeDigits(value);

  return digits.length === 8 ? digits : "";
}

function filenameMatchesDate(filename: string, dateKey: string) {
  return new RegExp(`(?:^|_)${dateKey}(?:_|\\.)`).test(filename);
}

function normalizeCompany(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function parseBoolean(value: unknown, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (["1", "true", "yes", "si"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseFileLimit(value: unknown) {
  const parsed = Math.trunc(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FILE_LIMIT;
  }

  return Math.min(parsed, 50);
}

function parseMoney(value: unknown) {
  const raw = String(value ?? "").trim().replace(/^"|"$/g, "");

  if (!raw) {
    return 0;
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  if (/^\d+(,\d+)?$/.test(raw)) {
    return Number(raw.replace(",", "."));
  }

  const digits = raw.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

function parseEfectyDate(value: unknown) {
  const raw = String(value ?? "").trim().replace(/^"|"$/g, "");

  if (!raw) {
    return null;
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (match) {
    // Efecty reports local Colombia time; the server may run in UTC.
    const colombiaDate = `${match[1]}-${match[2]}-${match[3]}`;
    const colombiaTime = `${match[4] || "12"}:${match[5] || "00"}:${match[6] || "00"}`;
    const date = new Date(`${colombiaDate}T${colombiaTime}-05:00`);

    return !Number.isNaN(date.getTime()) &&
      getBogotaCompactDateKey(date) === `${match[1]}${match[2]}${match[3]}`
      ? date
      : null;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parsePipeLine(line: string) {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (char === "|" && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields;
}

function buildPaymentKey(parts: {
  company: string;
  paidAt: Date | null;
  reference: string;
  value: number;
}) {
  return crypto
    .createHash("sha256")
    .update(
      [
        normalizeCompany(parts.company),
        normalizeDigits(parts.reference),
        Math.round(parts.value * 100),
        parts.paidAt?.toISOString() || "",
      ].join("|")
    )
    .digest("hex")
    .slice(0, 32);
}

function getValidCompanies() {
  const configured = String(process.env.EFECTY_VALID_COMPANIES || "")
    .split(",")
    .map(normalizeCompany)
    .filter(Boolean);

  return new Set(configured.length ? configured : DEFAULT_VALID_COMPANIES);
}

function getSftpConfig(): SftpConfig {
  const host = normalizeToken(process.env.EFECTY_SFTP_HOST || "mft.efecty.com.co");
  const username = normalizeToken(process.env.EFECTY_SFTP_USERNAME);
  const password = normalizeToken(process.env.EFECTY_SFTP_PASSWORD);
  const privateKey = normalizeToken(process.env.EFECTY_SFTP_PRIVATE_KEY).replace(
    /\\n/g,
    "\n"
  );

  if (!host || !username || (!password && !privateKey)) {
    throw new Error(
      "Faltan credenciales EFECTY_SFTP_HOST, EFECTY_SFTP_USERNAME y EFECTY_SFTP_PASSWORD o EFECTY_SFTP_PRIVATE_KEY."
    );
  }

  return {
    deleteAfterProcess: parseBoolean(process.env.EFECTY_SFTP_DELETE_AFTER_PROCESS),
    host,
    password: password || undefined,
    port: Math.trunc(Number(process.env.EFECTY_SFTP_PORT || 22)),
    privateKey: privateKey || undefined,
    remoteDir: normalizeToken(process.env.EFECTY_SFTP_REMOTE_DIR) || DEFAULT_REMOTE_DIR,
    username,
  };
}

export function parseEfectyRecaudoFile(content: string, sourceFile: string) {
  void sourceFile;
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ rawLine: line.trim(), lineNumber: index + 1 }))
    .filter((item) => item.rawLine)
    .map((item): EfectyLine | null => {
      const fields = parsePipeLine(item.rawLine);
      const lineType = fields[0]?.replace(/^"|"$/g, "").trim();

      if (lineType !== "02") {
        return null;
      }

      const reference = normalizeDigits(fields[1]);
      const value = parseMoney(fields[2]);
      const paidAt = parseEfectyDate(fields[3]);
      const company = normalizeCompany(fields[6]);

      return {
        company,
        fields,
        lineNumber: item.lineNumber,
        lineType,
        paidAt,
        paymentKey: buildPaymentKey({
          company,
          paidAt,
          reference,
          value,
        }),
        rawLine: item.rawLine,
        reference,
        value,
      };
    })
    .filter((item): item is EfectyLine => Boolean(item));
}

export async function ensureEfectyRecaudoImportSchema() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EfectyRecaudoImport" (
      "id" SERIAL PRIMARY KEY,
      "sourceFile" TEXT NOT NULL,
      "lineNumber" INTEGER NOT NULL,
      "paymentKey" TEXT NOT NULL,
      "lineType" TEXT,
      "referencia" TEXT,
      "clienteDocumento" TEXT,
      "empresa" TEXT,
      "valor" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "fechaPago" TIMESTAMP(3),
      "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
      "message" TEXT,
      "creditoId" INTEGER,
      "abonoId" INTEGER,
      "rawLine" TEXT NOT NULL,
      "payload" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "EfectyRecaudoImport_sourceFile_lineNumber_key"
    ON "EfectyRecaudoImport" ("sourceFile", "lineNumber")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "EfectyRecaudoImport_paymentKey_key"
    ON "EfectyRecaudoImport" ("paymentKey")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "EfectyRecaudoImport_clienteDocumento_idx"
    ON "EfectyRecaudoImport" ("clienteDocumento")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "EfectyRecaudoImport_referencia_idx"
    ON "EfectyRecaudoImport" ("referencia")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "EfectyRecaudoImport_status_createdAt_idx"
    ON "EfectyRecaudoImport" ("status", "createdAt")
  `);
}

async function findImportByPaymentKey(paymentKey: string) {
  const rows = await prisma.$queryRaw<EfectyImportRow[]>`
    SELECT id, status, message, "abonoId"
    FROM "EfectyRecaudoImport"
    WHERE "paymentKey" = ${paymentKey}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function insertImportLine(sourceFile: string, item: EfectyLine) {
  const payload = {
    fields: item.fields,
  } as Prisma.InputJsonValue;
  const rows = await prisma.$queryRaw<EfectyImportRow[]>`
    INSERT INTO "EfectyRecaudoImport" (
      "sourceFile", "lineNumber", "paymentKey", "lineType", "referencia",
      "clienteDocumento", "empresa", "valor", "fechaPago", status, message,
      "rawLine", payload, "updatedAt"
    )
    VALUES (
      ${sourceFile}, ${item.lineNumber}, ${item.paymentKey}, ${item.lineType},
      ${item.reference}, ${item.reference}, ${item.company}, ${item.value},
      ${item.paidAt}, 'PROCESANDO', NULL, ${item.rawLine}, ${payload}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("paymentKey") DO NOTHING
    RETURNING id, status, message, "abonoId"
  `;

  return rows[0] || null;
}

async function updateImportLine(
  id: number,
  data: {
    abonoId?: number | null;
    creditoId?: number | null;
    message: string;
    status: string;
  }
) {
  await prisma.$executeRaw`
    UPDATE "EfectyRecaudoImport"
    SET status = ${data.status},
        message = ${data.message},
        "creditoId" = ${data.creditoId ?? null},
        "abonoId" = ${data.abonoId ?? null},
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${id}
  `;
}

async function findCreditIdsByReference(reference: string) {
  if (!reference) {
    return [];
  }

  return prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id
    FROM "Credito"
    WHERE COALESCE(estado, '') <> 'ANULADO'
      AND "pazYSalvoEmitidoAt" IS NULL
      AND (
        REGEXP_REPLACE(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g') = ${reference}
        OR REGEXP_REPLACE(COALESCE("referenciaPago", ''), '[^0-9]', '', 'g') = ${reference}
      )
    ORDER BY id ASC
  `;
}

async function loadCandidateCredits(reference: string) {
  const ids = await findCreditIdsByReference(reference);

  if (!ids.length) {
    return [];
  }

  return prisma.credito.findMany({
    where: {
      id: {
        in: ids.map((item) => item.id),
      },
    },
    select: {
      id: true,
      folio: true,
      clienteNombre: true,
      clienteDocumento: true,
      clienteTelefono: true,
      imei: true,
      deviceUid: true,
      planCapitalVigente: true,
      saldoBaseFinanciado: true,
      montoCredito: true,
      valorInteres: true,
      valorFianza: true,
      valorCuota: true,
      plazoMeses: true,
      frecuenciaPago: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      estado: true,
      contratoSnapshot: true,
      referenciaPago: true,
      deliverableLabel: true,
      deliverableReady: true,
      equalityState: true,
      equalityService: true,
      equalityPayload: true,
      equalityLastCheckAt: true,
      bloqueoRobo: true,
      bloqueoRoboAt: true,
      bloqueoMora: true,
      bloqueoMoraAt: true,
      pazYSalvoEmitidoAt: true,
      observacionAdmin: true,
      usuarioId: true,
      vendedorId: true,
      sedeId: true,
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
      id: "asc",
    },
  });
}

function scoreCreditsForPayment(
  credits: Awaited<ReturnType<typeof loadCandidateCredits>>,
  value: number
) {
  const scored = credits
    .map((credit) => {
      const plan = buildCreditPaymentPlan({
        planCapitalVigente: credit.planCapitalVigente,
        montoCredito: Number(credit.montoCredito || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
        fechaProximoPago: credit.fechaProximoPago,
        abonos: credit.abonos.map((abono) => ({
          valor: Number(abono.valor || 0),
          fechaAbono: abono.fechaAbono,
        })),
      });
      const nextBalance = Number(plan.nextInstallment?.saldoPendiente || 0);
      const exactNextPayment = Math.abs(Math.round(nextBalance) - Math.round(value)) <= 1;
      const payable = plan.saldoPendiente > 0 && value <= plan.saldoPendiente + 1;

      return {
        credit,
        exactNextPayment,
        nextDate: plan.nextInstallment?.fechaVencimiento || "9999-12-31",
        overdueCount: plan.overdueCount,
        payable,
        saldoPendiente: plan.saldoPendiente,
      };
    })
    .filter((item) => item.payable)
    .sort((a, b) => {
      if (a.exactNextPayment !== b.exactNextPayment) {
        return a.exactNextPayment ? -1 : 1;
      }

      if (a.overdueCount !== b.overdueCount) {
        return b.overdueCount - a.overdueCount;
      }

      if (a.nextDate !== b.nextDate) {
        return a.nextDate.localeCompare(b.nextDate);
      }

      return a.credit.id - b.credit.id;
    });

  return scored;
}

function matchingEfectyPayoff(
  credit: Awaited<ReturnType<typeof loadCandidateCredits>>[number],
  item: EfectyLine
) {
  const paidAt = item.paidAt;

  if (!paidAt) {
    return null;
  }

  const priorAbonos = credit.abonos.filter((abono) => abono.fechaAbono <= paidAt);
  const hasLaterPayments = priorAbonos.length !== credit.abonos.length;

  const payoff = calculateCreditEarlyPayoff({
    contratoSnapshot: credit.contratoSnapshot,
    planCapitalVigente: credit.planCapitalVigente,
    saldoBaseFinanciado: Number(credit.saldoBaseFinanciado || 0),
    montoCredito: Number(credit.montoCredito || 0),
    valorInteres: Number(credit.valorInteres || 0),
    valorFianza: Number(credit.valorFianza || 0),
    valorCuota: Number(credit.valorCuota || 0),
    plazoMeses: Number(credit.plazoMeses || 1),
    frecuenciaPago: credit.frecuenciaPago,
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    fechaProximoPago: credit.fechaProximoPago,
    abonos: priorAbonos.map((abono) => ({
      valor: Number(abono.valor || 0),
      fechaAbono: abono.fechaAbono,
    })),
    today: paidAt,
    settled: Boolean(credit.pazYSalvoEmitidoAt),
  });

  return payoff.eligible &&
    Math.round(item.value * 100) === Math.round(payoff.capitalPendiente * 100)
    ? { hasLaterPayments, payoff }
    : null;
}

function matchesEfectyIntentQuote(
  quote: Awaited<ReturnType<typeof findEfectyPayoffIntent>>,
  payoff: CreditEarlyPayoffResult
) {
  if (!quote || !payoff.eligible ||
      quote.quote.planRevision !== payoff.planRevision) {
    return false;
  }

  const quoted = quote.quote;
  const values = [
    [quoted.capitalPendiente, payoff.capitalPendiente],
    [quoted.condonacion, payoff.interesFianzaCondonado],
    [quoted.montoCreditoLiquidado, payoff.montoCreditoLiquidado],
    [quoted.saldoObligacion, payoff.saldoObligacion],
    ...(quoted.totalAbonado === undefined
      ? []
      : [[quoted.totalAbonado, payoff.totalAbonado]]),
  ];

  return values.every(([expected, current]) =>
    Math.round(expected * 100) === Math.round(current * 100)
  );
}

async function loadCreditForMora(creditId: number) {
  return prisma.credito.findUnique({
    where: { id: creditId },
    select: {
      id: true,
      folio: true,
      clienteNombre: true,
      clienteDocumento: true,
      clienteTelefono: true,
      imei: true,
      deviceUid: true,
      planCapitalVigente: true,
      montoCredito: true,
      valorCuota: true,
      plazoMeses: true,
      frecuenciaPago: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      estado: true,
      deliverableLabel: true,
      deliverableReady: true,
      equalityState: true,
      equalityService: true,
      equalityPayload: true,
      equalityLastCheckAt: true,
      bloqueoRobo: true,
      bloqueoRoboAt: true,
      bloqueoMora: true,
      bloqueoMoraAt: true,
      pazYSalvoEmitidoAt: true,
      observacionAdmin: true,
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
  });
}

async function applyEfectyLine(sourceFile: string, item: EfectyLine) {
  const validCompanies = getValidCompanies();

  if (!validCompanies.has(item.company)) {
    return {
      action: "OMITIDO_EMPRESA",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: `Empresa no FINSERPAY: ${item.company || "sin empresa"}`,
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  if (!item.reference || item.value <= 0 || !item.paidAt) {
    return {
      action: "VALOR_INVALIDO",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: "La linea no tiene referencia, valor o fecha valida.",
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  const existing = await findImportByPaymentKey(item.paymentKey);

  if (existing && existing.status !== "PROCESANDO") {
    return {
      abonoId: existing.abonoId,
      action: actionForExistingImport(existing.status),
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: existing.message || "Recaudo Efecty ya procesado.",
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  const importLine = existing || (await insertImportLine(sourceFile, item));

  if (!importLine) {
    const duplicated = await findImportByPaymentKey(item.paymentKey);

    return {
      abonoId: duplicated?.abonoId || null,
      action: actionForExistingImport(duplicated?.status || ""),
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: duplicated?.message || "Recaudo Efecty ya registrado.",
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  const candidates = await loadCandidateCredits(item.reference);
  const directReferenceCandidates = candidates.filter(
    (candidate) =>
      candidate.referenciaPago &&
      normalizeDigits(candidate.referenciaPago) === item.reference
  );
  const scopedCandidates = directReferenceCandidates.length
    ? directReferenceCandidates
    : candidates;
  await ensureEfectyPayoffIntentTable();
  const intentCandidates = (
    await Promise.all(scopedCandidates.map(async (candidate) => ({
      candidate,
      intent: await findEfectyPayoffIntent(prisma, {
        creditoId: candidate.id,
        referencia: item.reference,
        amountInCents: Math.round(item.value * 100),
        paidAt: item.paidAt!,
      }),
    })))
  ).filter(({ intent }) => Boolean(intent));
  const explicitIntent = intentCandidates.length === 1
    ? intentCandidates[0]
    : null;
  const matchingPayoffs = scopedCandidates.map((candidate) => ({
    candidate,
    match: matchingEfectyPayoff(candidate, item),
  }));
  const payableCandidates = scoreCreditsForPayment(scopedCandidates, item.value);
  const payoffCandidates = payableCandidates.filter(({ credit: candidate }) =>
    Boolean(matchingPayoffs.find(({ candidate: match }) => match.id === candidate.id)?.match)
  );
  const historicalPayoff = matchingPayoffs.some(({ match }) => match?.hasLaterPayments);
  const payoffAmbiguous = historicalPayoff ||
    intentCandidates.length > 1 ||
    (!explicitIntent && payoffCandidates.length > 0 && scopedCandidates.length !== 1);
  const credit = explicitIntent?.candidate ||
    payoffCandidates[0]?.credit || payableCandidates[0]?.credit || null;
  const matchesOrdinaryInstallment = payoffCandidates.some(
    ({ exactNextPayment, saldoPendiente }) =>
      exactNextPayment && Math.round((saldoPendiente - item.value) * 100) > 0
  );
  const intendedPayoff = !payoffAmbiguous &&
    (Boolean(explicitIntent) ||
      (payoffCandidates.length === 1 && !matchesOrdinaryInstallment));

  if (payoffAmbiguous) {
    const message = historicalPayoff
      ? "El valor coincide con una liquidacion anterior, pero hay abonos posteriores. Requiere conciliacion manual."
      : intentCandidates.length > 1
        ? "Hay varias instrucciones de liquidacion para la referencia Efecty. Requiere conciliacion manual."
      : "El valor coincide con una liquidacion, pero la referencia identifica varios creditos vigentes. Requiere conciliacion manual.";

    await updateImportLine(importLine.id, {
      message,
      status: "REVISION_REQUERIDA",
    });

    return {
      action: "REVISION_REQUERIDA",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message,
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  if (!candidates.length || !credit) {
    const hasCandidates = candidates.length > 0;
    const message = hasCandidates
      ? "La cedula existe, pero el valor supera el saldo pendiente de los creditos vigentes."
      : "No se encontro credito vigente para la referencia Efecty.";
    const status = hasCandidates ? "VALOR_SUPERA_SALDO" : "SIN_CREDITO";

    await updateImportLine(importLine.id, {
      message,
      status,
    });

    return {
      action: status,
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message,
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  const digitalSede = await ensureDigitalCollectionSede();
  const application = await prisma.$transaction(async (tx) => {
    const lockedCandidates = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "Credito"
      WHERE COALESCE(estado, '') <> 'ANULADO'
        AND "pazYSalvoEmitidoAt" IS NULL
        AND (
          REGEXP_REPLACE(COALESCE("clienteDocumento", ''), '[^0-9]', '', 'g') = ${item.reference}
          OR REGEXP_REPLACE(COALESCE("referenciaPago", ''), '[^0-9]', '', 'g') = ${item.reference}
        )
      ORDER BY "id" ASC
      FOR UPDATE
    `;
    const locked = lockedCandidates.filter((candidate) => candidate.id === credit.id);
    const lockedImports = await tx.$queryRaw<EfectyImportRow[]>`
      SELECT id, status, message, "abonoId"
      FROM "EfectyRecaudoImport"
      WHERE id = ${importLine.id}
      FOR UPDATE
    `;
    const lockedImport = lockedImports[0] || null;

    if (
      !lockedImport ||
      lockedImport.status !== "PROCESANDO" ||
      lockedImport.abonoId
    ) {
      return {
        abonoId: lockedImport?.abonoId || null,
        kind: "DUPLICATE" as const,
        message: lockedImport?.message || "Recaudo Efecty ya procesado.",
      };
    }

    const lockedCredit = locked.length
      ? await tx.credito.findUnique({
          where: { id: credit.id },
          select: {
            clienteNombre: true,
            estado: true,
            fechaPrimerPago: true,
            fechaProximoPago: true,
            folio: true,
            frecuenciaPago: true,
            id: true,
            planCapitalVigente: true,
            saldoBaseFinanciado: true,
            montoCredito: true,
            valorInteres: true,
            valorFianza: true,
            contratoSnapshot: true,
            observacionAdmin: true,
            pazYSalvoEmitidoAt: true,
            plazoMeses: true,
            sedeId: true,
            usuarioId: true,
            valorCuota: true,
          },
        })
      : null;
    const previousAbonos = lockedCredit
      ? await tx.creditoAbono.findMany({
          where: {
            creditoId: lockedCredit.id,
            estado: { not: "ANULADO" },
          },
          select: {
            fechaAbono: true,
            valor: true,
          },
          orderBy: {
            fechaAbono: "asc",
          },
        })
      : [];
    const currentPlan = lockedCredit
      ? buildCreditPaymentPlan({
          planCapitalVigente: lockedCredit.planCapitalVigente,
          montoCredito: Number(lockedCredit.montoCredito || 0),
          valorCuota: Number(lockedCredit.valorCuota || 0),
          plazoMeses: Number(lockedCredit.plazoMeses || 1),
          frecuenciaPago: lockedCredit.frecuenciaPago,
          fechaPrimerPago:
            lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
          fechaProximoPago: lockedCredit.fechaProximoPago,
          abonos: previousAbonos.map((abonoItem) => ({
            valor: Number(abonoItem.valor || 0),
            fechaAbono: abonoItem.fechaAbono,
          })),
        })
      : null;
    const balanceInCents = currentPlan
      ? Math.max(0, Math.round(currentPlan.saldoPendiente * 100))
      : 0;
    const earlyPayoff = intendedPayoff && lockedCredit && item.paidAt &&
      !previousAbonos.some((abonoItem) => abonoItem.fechaAbono > item.paidAt!)
      ? calculateCreditEarlyPayoff({
          contratoSnapshot: lockedCredit.contratoSnapshot,
          planCapitalVigente: lockedCredit.planCapitalVigente,
          saldoBaseFinanciado: Number(lockedCredit.saldoBaseFinanciado || 0),
          montoCredito: Number(lockedCredit.montoCredito || 0),
          valorInteres: Number(lockedCredit.valorInteres || 0),
          valorFianza: Number(lockedCredit.valorFianza || 0),
          valorCuota: Number(lockedCredit.valorCuota || 0),
          plazoMeses: Number(lockedCredit.plazoMeses || 1),
          frecuenciaPago: lockedCredit.frecuenciaPago,
          fechaPrimerPago:
            lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
          fechaProximoPago: lockedCredit.fechaProximoPago,
          abonos: previousAbonos.map((abonoItem) => ({
            valor: Number(abonoItem.valor || 0),
            fechaAbono: abonoItem.fechaAbono,
          })),
          today: item.paidAt,
          settled: Boolean(lockedCredit.pazYSalvoEmitidoAt),
        })
      : null;
    const lockedIntent = explicitIntent && lockedCredit
      ? await findEfectyPayoffIntent(tx, {
          creditoId: lockedCredit.id,
          referencia: item.reference,
          amountInCents: Math.round(item.value * 100),
          paidAt: item.paidAt!,
        })
      : null;

    if (
      !lockedCredit ||
      String(lockedCredit.estado || "").toUpperCase() === "ANULADO" ||
      lockedCredit.pazYSalvoEmitidoAt ||
      balanceInCents <= 0 ||
      Math.round(item.value * 100) > balanceInCents
    ) {
      const message =
        "El saldo del credito cambio antes de aplicar el recaudo Efecty.";

      await tx.$executeRaw`
        UPDATE "EfectyRecaudoImport"
        SET status = 'VALOR_SUPERA_SALDO',
            message = ${message},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${importLine.id}
      `;

      return {
        kind: "REJECTED" as const,
        message,
      };
    }

    if (
      intendedPayoff &&
      (!earlyPayoff?.eligible ||
        Math.round(item.value * 100) !==
          Math.round(earlyPayoff.capitalPendiente * 100) ||
        (!explicitIntent && lockedCandidates.length !== 1) ||
        (explicitIntent &&
          (lockedIntent?.id !== explicitIntent.intent?.id ||
            !matchesEfectyIntentQuote(lockedIntent, earlyPayoff))))
    ) {
      const message =
        "La liquidacion cotizada cambio antes de aplicar el recaudo Efecty. Requiere conciliacion manual.";

      await tx.$executeRaw`
        UPDATE "EfectyRecaudoImport"
        SET status = 'REVISION_REQUERIDA',
            message = ${message},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${importLine.id}
      `;

      return {
        kind: "REVIEW" as const,
        message,
      };
    }

    if (lockedIntent &&
        !(await consumeEfectyPayoffIntent(tx, lockedIntent.id, item.paymentKey))) {
      const message =
        "La instruccion de liquidacion Efecty ya fue utilizada. Requiere conciliacion manual.";

      await tx.$executeRaw`
        UPDATE "EfectyRecaudoImport"
        SET status = 'REVISION_REQUERIDA',
            message = ${message},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${importLine.id}
      `;

      return {
        kind: "REVIEW" as const,
        message,
      };
    }

    const observation = [
      `Pago EFECTY automatico ${item.paymentKey}`,
      ...(earlyPayoff ? [buildEarlyPayoffObservation(earlyPayoff)] : []),
      `Archivo ${sourceFile} linea ${item.lineNumber}`,
      `Referencia ${item.reference}`,
      `Recaudo digital ${digitalSede.nombre}`,
      `Sede credito ${lockedCredit.sedeId}`,
    ].join(" - ");
    const created = await tx.creditoAbono.create({
      data: {
        creditoId: lockedCredit.id,
        usuarioId: lockedCredit.usuarioId,
        vendedorId: null,
        sedeId: digitalSede.id,
        valor: item.value,
        metodoPago: "EFECTY",
        observacion: observation,
        fechaAbono: item.paidAt || new Date(),
      },
    });
    const abonos = await tx.creditoAbono.findMany({
      where: {
        creditoId: lockedCredit.id,
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
    });
    const plan = buildCreditPaymentPlan({
      planCapitalVigente: lockedCredit.planCapitalVigente,
      montoCredito: Number(lockedCredit.montoCredito || 0),
      valorCuota: Number(lockedCredit.valorCuota || 0),
      plazoMeses: Number(lockedCredit.plazoMeses || 1),
      frecuenciaPago: lockedCredit.frecuenciaPago,
      fechaPrimerPago:
        lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
      abonos: abonos.map((abonoItem) => ({
        valor: Number(abonoItem.valor || 0),
        fechaAbono: abonoItem.fechaAbono,
      })),
    });
    const finalized = Boolean(earlyPayoff) || Math.round(plan.saldoPendiente * 100) <= 0;
    const issuedAt = finalized ? new Date() : null;
    const nextPaymentDate = finalized
      ? null
      : resolveNextPaymentDateAfterPayment({
          afterPayment: plan.nextInstallment,
          beforePayment: currentPlan?.nextInstallment || null,
          currentNextPaymentDate: lockedCredit.fechaProximoPago,
        });

    await tx.credito.update({
      where: { id: lockedCredit.id },
      data: earlyPayoff
        ? {
            bloqueoMora: false,
            bloqueoMoraAt: null,
            estado: resolveCreditState({ pazYSalvoEmitidoAt: issuedAt }),
            fechaProximoPago: null,
            montoCredito: earlyPayoff.montoCreditoLiquidado,
            observacionAdmin: [
              lockedCredit.observacionAdmin,
              `Liquidacion anticipada Efecty ${item.paymentKey}. Condonado intereses/fianza ${earlyPayoff.interesFianzaCondonado}.`,
            ].filter(Boolean).join("\n"),
            pazYSalvoEmitidoAt: issuedAt,
            valorFianza: earlyPayoff.valorFianzaReconocida,
            valorInteres: earlyPayoff.valorInteresReconocido,
            ...(readMassCreditComponents(lockedCredit.contratoSnapshot, lockedCredit)
              ? {
                  contratoSnapshot: updateMassCreditComponentsForPayoff(
                    lockedCredit.contratoSnapshot,
                    {
                      montoCredito: earlyPayoff.montoCreditoLiquidado,
                      valorFianza: earlyPayoff.valorFianzaReconocida,
                      valorInteres: earlyPayoff.valorInteresReconocido,
                      valorSeguro: earlyPayoff.valorSeguroReconocido ?? 0,
                    }
                  ) as Prisma.InputJsonValue,
                }
              : {}),
          }
        : finalized
        ? {
            bloqueoMora: false,
            bloqueoMoraAt: null,
            estado: resolveCreditState({ pazYSalvoEmitidoAt: issuedAt }),
            fechaProximoPago: null,
            pazYSalvoEmitidoAt: issuedAt,
          }
        : {
            fechaProximoPago: nextPaymentDate,
          },
    });

    await tx.cajaMovimiento.create({
      data: {
        tipo: "INGRESO",
        concepto: DIGITAL_COLLECTION_CAJA_CONCEPT,
        valor: item.value,
        descripcion: creditCajaDescription({
          id: created.id,
          creditoFolio: lockedCredit.folio,
          clienteNombre: lockedCredit.clienteNombre,
          metodoPago: "EFECTY",
          observacion: `Referencia Efecty ${item.reference} | Archivo ${sourceFile} | Sede credito ${lockedCredit.sedeId}`,
        }),
        sedeId: digitalSede.id,
      },
    });

    await tx.$executeRaw`
      UPDATE "EfectyRecaudoImport"
      SET status = 'APLICADO',
          message = ${earlyPayoff
            ? "Liquidacion anticipada Efecty aplicada automaticamente"
            : "Abono aplicado automaticamente"},
          "creditoId" = ${lockedCredit.id},
          "abonoId" = ${created.id},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${importLine.id}
    `;

    return {
      abono: created,
      earlyPayoff: Boolean(earlyPayoff),
      finalized,
      kind: "APPLIED" as const,
    };
  });

  if (application.kind === "REJECTED") {
    return {
      action: "VALOR_SUPERA_SALDO",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: application.message,
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  if (application.kind === "REVIEW") {
    return {
      action: "REVISION_REQUERIDA",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: application.message,
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  if (application.kind === "DUPLICATE") {
    return {
      abonoId: application.abonoId,
      action: "DUPLICADO",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: application.message,
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  const abono = application.abono;

  if (application.finalized) {
    try {
      const unlockCommand = await enqueueUnlockForCurrentCredit({
        commandKey: `EFECTY:${importLine.id}:${abono.id}`,
        creditoId: credit.id,
        source: "EFECTY",
        sourceReference: item.paymentKey,
      });

      if (unlockCommand && unlockCommand.status !== "CONFIRMED") {
        await processDeviceUnlockCommand(unlockCommand.id);
      }
    } catch (error) {
      console.error(
        `[efecty-unlock] El credito ${credit.id} quedo pagado; el desbloqueo sigue en cola:`,
        error
      );
    }
  }

  const updatedCredit = await loadCreditForMora(credit.id);

  if (updatedCredit) {
    await syncCreditMora(updatedCredit);
  }

  return {
    abonoId: abono.id,
    action: "APLICADO",
    creditoId: credit.id,
    empresa: item.company,
    file: sourceFile,
    lineNumber: item.lineNumber,
    message: application.earlyPayoff
      ? "Liquidacion anticipada Efecty aplicada automaticamente."
      : "Abono Efecty aplicado automaticamente.",
    referencia: item.reference,
    value: item.value,
  } satisfies EfectyLineResult;
}

export async function processEfectyRecaudoContent(
  sourceFile: string,
  content: string,
  options: EfectySyncOptions = {}
): Promise<EfectyFileResult> {
  await ensureCreditAbonoAuditColumns();
  await ensureEfectyRecaudoImportSchema();

  const lines = parseEfectyRecaudoFile(content, sourceFile);

  if (options.dryRun) {
    const validCompanies = getValidCompanies();

    return {
      file: sourceFile,
      lines: lines.map((item) => ({
        action: validCompanies.has(item.company)
          ? "VISTA_PREVIA"
          : "OMITIDO_EMPRESA",
        empresa: item.company,
        file: sourceFile,
        lineNumber: item.lineNumber,
        message: validCompanies.has(item.company)
          ? "Linea FINSERPAY lista para procesar."
          : `Empresa no FINSERPAY: ${item.company || "sin empresa"}`,
        referencia: item.reference,
        value: item.value,
      })),
    };
  }

  const results: EfectyLineResult[] = [];

  for (const line of lines) {
    try {
      results.push(await applyEfectyLine(sourceFile, line));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "No se pudo procesar la linea Efecty.";

      results.push({
        action: "ERROR",
        empresa: line.company,
        file: sourceFile,
        lineNumber: line.lineNumber,
        message,
        referencia: line.reference,
        value: line.value,
      });
    }
  }

  return {
    file: sourceFile,
    lines: results,
  };
}

async function downloadRemoteFile(
  sftp: SftpClient,
  remoteDir: string,
  filename: string
) {
  const remotePath = path.posix.join(remoteDir, filename);
  const data = await sftp.get(remotePath);

  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
}

export async function syncEfectyRecaudosFromSftp(options: EfectySyncOptions = {}) {
  const config = getSftpConfig();
  const sftp = new SftpClient("finserpay-efecty");
  const limitFiles = parseFileLimit(options.limitFiles);

  await sftp.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    privateKey: config.privateKey,
    readyTimeout: 30000,
  });

  try {
    const listing = await sftp.list(config.remoteDir);
    const requestedNames = new Set((options.filenames || []).filter(Boolean));
    const targetDate =
      requestedNames.size || options.includePreviousFiles
        ? ""
        : normalizeFileDate(options.fileDate) || getBogotaCompactDateKey();
    const filenames = listing
      .map((item) => item.name)
      .filter((name) => /\.txt$/i.test(name))
      .filter((name) =>
        requestedNames.size ? requestedNames.has(name) : /^RECAUDO_EFECTIVO/i.test(name)
      )
      .filter((name) => (targetDate ? filenameMatchesDate(name, targetDate) : true))
      .sort()
      .slice(-limitFiles);
    const files: EfectyFileResult[] = [];

    for (const filename of filenames) {
      const content = await downloadRemoteFile(sftp, config.remoteDir, filename);
      const result = await processEfectyRecaudoContent(filename, content, options);
      files.push(result);

      if (
        config.deleteAfterProcess &&
        !options.dryRun &&
        result.lines.every((line) =>
          line.action !== "ERROR" && !PENDING_EFECTY_ACTIONS.has(line.action)
        )
      ) {
        await sftp.delete(path.posix.join(config.remoteDir, filename));
      }
    }

    const lines = files.flatMap((file) => file.lines);

    return {
      ok: lines.every((line) =>
        line.action !== "ERROR" && !PENDING_EFECTY_ACTIONS.has(line.action)
      ),
      dryRun: Boolean(options.dryRun),
      generatedAt: new Date().toISOString(),
      selection: {
        mode: requestedNames.size
          ? "filenames"
          : options.includePreviousFiles
            ? "latest"
            : "today",
        remoteDir: config.remoteDir,
        selectedFiles: filenames,
        targetDate: targetDate || null,
      },
      summary: {
        applied: lines.filter((line) => line.action === "APLICADO").length,
        duplicated: lines.filter((line) => line.action === "DUPLICADO").length,
        errors: lines.filter((line) => line.action === "ERROR").length,
        files: files.length,
        omitted: lines.filter((line) => line.action === "OMITIDO_EMPRESA").length,
        pending: lines.filter((line) => PENDING_EFECTY_ACTIONS.has(line.action)).length,
        preview: lines.filter((line) => line.action === "VISTA_PREVIA").length,
        totalLines: lines.length,
      },
      files,
    };
  } finally {
    await sftp.end().catch(() => undefined);
  }
}
