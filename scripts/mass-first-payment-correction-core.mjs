import { createHash } from "node:crypto";

export function normalizeDocument(value) {
  return String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

export function dateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid date");
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(raw);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T12:00:00.000Z`))) {
    throw new Error("Invalid imported date");
  }
  const key = match[1];
  if (new Date(`${key}T12:00:00.000Z`).toISOString().slice(0, 10) !== key) {
    throw new Error("Invalid imported civil date");
  }
  return key;
}

export function firstDueDateCatorcenal(creditDate) {
  const from = new Date(`${dateKey(creditDate)}T12:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() + 14);
  return from.toISOString().slice(0, 10);
}

export function canonicalRow(receipt) {
  const normalized = receipt?.normalized;
  const document = normalizeDocument(normalized?.cedula);
  const sadmin = String(normalized?.numeroCreditoSadmin ?? "").trim().toLowerCase();
  const frequency = String(normalized?.frecuencia ?? "").trim().toUpperCase();
  if (!Number.isSafeInteger(receipt?.rowNumber) || receipt.rowNumber < 1 ||
      !/^[0-9]{5,20}$/.test(document) || !sadmin || frequency !== "CATORCENAL") {
    throw new Error("Invalid imported receipt identity");
  }
  return [document, sadmin, dateKey(normalized?.fecha), dateKey(normalized?.fechaPago), frequency].join("|");
}

export function fingerprintBatch(receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error("Imported batch has no receipts");
  }
  const sorted = [...receipts].sort((left, right) => left.rowNumber - right.rowNumber);
  const lines = sorted.map((receipt, index) => {
    if (receipt?.rowNumber !== index + 1) throw new Error("Imported row numbers are not contiguous");
    return canonicalRow(receipt);
  });
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export function validateImportedCredit(row) {
  const snapshot = row.snapshot;
  const origin = snapshot?.origen;
  const financial = snapshot?.financiero;
  const receipt = origin?.importReceipt;
  const normalized = receipt?.normalized;
  canonicalRow(receipt);
  if (receipt.ok !== true || !Array.isArray(receipt.errors) || receipt.errors.length !== 0 ||
      origin.tipo !== "IMPORTACION_MASIVA" || origin.batchId !== origin.requestId ||
      origin.sadminConfirmation !== "ADMIN_EXISTING_SADMIN" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(origin.batchId ?? "")) ||
      normalizeDocument(row.clientDocument) !== normalizeDocument(normalized.cedula) ||
      String(origin.numeroCreditoSadmin ?? "").trim().toLowerCase() !==
        String(normalized.numeroCreditoSadmin ?? "").trim().toLowerCase() ||
      !row.sadmin?.codeudorCreado || !row.sadmin?.creditoCreado ||
      !row.sadmin?.numeroCreditoConfirmado || !row.sadmin?.completedAt ||
      String(row.sadmin.numeroCredito ?? "").trim().toLowerCase() !==
        String(normalized.numeroCreditoSadmin ?? "").trim().toLowerCase() ||
      row.equalityService !== "IMPORTACION_MASIVA" || row.state !== "GENERADO" ||
      row.frequency !== "CATORCENAL" || financial?.frecuenciaPago !== "CATORCENAL" ||
      dateKey(row.creditDate) !== dateKey(normalized.fecha) ||
      dateKey(financial?.fechaCredito) !== dateKey(normalized.fecha) ||
      dateKey(row.firstPayment) !== dateKey(normalized.fechaPago) ||
      dateKey(row.nextPayment) !== dateKey(normalized.fechaPago) ||
      dateKey(financial?.fechaPrimerPago) !== dateKey(normalized.fechaPago) ||
      origin.firstPaymentCorrection !== undefined) {
    throw new Error("Imported credit identity or original payment dates changed");
  }
  return {
    previousDate: dateKey(normalized.fechaPago),
    correctedDate: firstDueDateCatorcenal(normalized.fecha),
    rowNumber: receipt.rowNumber,
    batchId: origin.batchId,
  };
}

export function validateCreditActivity(row) {
  const local = [
    row?.deliverableReady,
    row?.pazYSalvoEmitidoAt,
    row?.contratoAceptadoAt,
    row?.pagareAceptadoAt,
    row?.contratoFirmaDataUrl,
    row?.contratoFotoDataUrl,
    row?.contratoSelfieDataUrl,
    row?.contratoOtpVerificadoAt,
  ];
  const activityKinds = [
    "abono", "amortizacion", "wompi", "liquidacion", "approval", "reissue",
    "data_correction", "novelty", "call_recording", "evidence_revision",
    "firmaSeguro",
  ];
  if (row?.sadminVersion !== 1 || local.some(Boolean) ||
      activityKinds.some((kind) => row?.activity?.[kind] === true)) {
    throw new Error("Historical credit has subsequent activity");
  }
  return true;
}
