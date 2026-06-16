import crypto from "node:crypto";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { creditCajaDescription } from "@/lib/credit-factory";
import { syncCreditMora } from "@/lib/credit-mora-sync";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  DIGITAL_COLLECTION_CAJA_CONCEPT,
  ensureDigitalCollectionSede,
} from "@/lib/digital-collection-sede";
import prisma from "@/lib/prisma";

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
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 12),
      Number(match[5] || 0),
      Number(match[6] || 0),
      0
    );

    return Number.isNaN(date.getTime()) ? null : date;
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

function pickCreditForPayment(
  credits: Awaited<ReturnType<typeof loadCandidateCredits>>,
  value: number
) {
  const scored = credits
    .map((credit) => {
      const plan = buildCreditPaymentPlan({
        montoCredito: Number(credit.montoCredito || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
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

  return scored[0]?.credit || null;
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
      action: "DUPLICADO",
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
      action: "DUPLICADO",
      empresa: item.company,
      file: sourceFile,
      lineNumber: item.lineNumber,
      message: duplicated?.message || "Recaudo Efecty ya registrado.",
      referencia: item.reference,
      value: item.value,
    } satisfies EfectyLineResult;
  }

  const candidates = await loadCandidateCredits(item.reference);
  const credit = pickCreditForPayment(candidates, item.value);

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
  const abono = await prisma.$transaction(async (tx) => {
    const observation = [
      `Pago EFECTY automatico ${item.paymentKey}`,
      `Archivo ${sourceFile} linea ${item.lineNumber}`,
      `Referencia ${item.reference}`,
      `Recaudo digital ${digitalSede.nombre}`,
      `Sede credito ${credit.sedeId}`,
    ].join(" - ");
    const created = await tx.creditoAbono.create({
      data: {
        creditoId: credit.id,
        usuarioId: credit.usuarioId,
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
        creditoId: credit.id,
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
      montoCredito: Number(credit.montoCredito || 0),
      valorCuota: Number(credit.valorCuota || 0),
      plazoMeses: Number(credit.plazoMeses || 1),
      frecuenciaPago: credit.frecuenciaPago,
      fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
      abonos: abonos.map((abonoItem) => ({
        valor: Number(abonoItem.valor || 0),
        fechaAbono: abonoItem.fechaAbono,
      })),
    });

    await tx.credito.update({
      where: { id: credit.id },
      data: {
        fechaProximoPago: plan.nextInstallment?.fechaVencimiento
          ? new Date(`${plan.nextInstallment.fechaVencimiento}T12:00:00.000Z`)
          : credit.fechaProximoPago,
      },
    });

    await tx.cajaMovimiento.create({
      data: {
        tipo: "INGRESO",
        concepto: DIGITAL_COLLECTION_CAJA_CONCEPT,
        valor: item.value,
        descripcion: creditCajaDescription({
          id: created.id,
          creditoFolio: credit.folio,
          clienteNombre: credit.clienteNombre,
          metodoPago: "EFECTY",
          observacion: `Referencia Efecty ${item.reference} | Archivo ${sourceFile} | Sede credito ${credit.sedeId}`,
        }),
        sedeId: digitalSede.id,
      },
    });

    await tx.$executeRaw`
      UPDATE "EfectyRecaudoImport"
      SET status = 'APLICADO',
          message = 'Abono aplicado automaticamente',
          "creditoId" = ${credit.id},
          "abonoId" = ${created.id},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${importLine.id}
    `;

    return created;
  });
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
    message: "Abono Efecty aplicado automaticamente.",
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
        result.lines.every((line) => line.action !== "ERROR")
      ) {
        await sftp.delete(path.posix.join(config.remoteDir, filename));
      }
    }

    const lines = files.flatMap((file) => file.lines);

    return {
      ok: lines.every((line) => line.action !== "ERROR"),
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
        pending: lines.filter(
          (line) =>
            line.action === "SIN_CREDITO" ||
            line.action === "VALOR_INVALIDO" ||
            line.action === "VALOR_SUPERA_SALDO"
        ).length,
        preview: lines.filter((line) => line.action === "VISTA_PREVIA").length,
        totalLines: lines.length,
      },
      files,
    };
  } finally {
    await sftp.end().catch(() => undefined);
  }
}
