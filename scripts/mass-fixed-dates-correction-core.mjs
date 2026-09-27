// One-time calendar correction for the six-row import reviewed on 2026-09-27.
// Financial terms and the immutable import receipt remain unchanged.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const { getQuincenalFirstPaymentDateObject } = await jiti.import('../lib/credit-factory.ts');
const { buildCreditPaymentPlan } = await jiti.import('../lib/credit-payment-plan.ts');
const { readMassCreditComponents } = await jiti.import('../lib/mass-credit-financial-components.ts');

export const fixedDatesBatchId = '6107be68-cdcb-4b97-b1d9-64b0c77a4e31';
export const fixedDatesCorrectionKey = 'MASS_SIX_FIXED_DATES_20260927_V1';
export const fixedDatesPolicy = 'QUINCENAL_02_17_ACTIVATION_1_5_SAME_17_6_20_NEXT_02_21_31_NEXT_17';
export const fixedDatesTargets = Object.freeze([
  [775, 1400000, 152750, 17, '2026-09-02'],
  [776, 2800000, 119350, 48, '2026-09-02'],
  [777, 1680000, 157250, 20, '2026-09-02'],
  [778, 1800000, 154100, 22, '2026-09-02'],
  [779, 2800000, 157050, 35, '2026-09-02'],
  [780, 3440000, 146750, 48, '2026-09-17'],
].map(([id, capital, cuota, numeroCuotas, activationDate], index) =>
  Object.freeze({ id, capital, cuota, numeroCuotas, activationDate, rowNumber: index + 1 })));

export class FixedDatesCorrectionBlocked extends Error {}
function requireCondition(condition, message) {
  if (!condition) throw new FixedDatesCorrectionBlocked(message);
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export function civilDateKey(value) {
  const raw = value instanceof Date ? value.toISOString() : String(value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(raw);
  requireCondition(match, 'Una fecha de calendario no es válida.');
  const parsed = new Date(`${match[1]}T12:00:00.000Z`);
  requireCondition(!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1],
    'Una fecha civil no es válida.');
  return match[1];
}
export function policyFirstPaymentDate(value) {
  // Civil UTC noon avoids changing the imported activation day in another timezone.
  return civilDateKey(getQuincenalFirstPaymentDateObject(`${civilDateKey(value)}T12:00:00.000Z`));
}
export function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(
    Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])));
  return JSON.stringify(value);
}
function paymentAllocation(plan) {
  return plan.installments.map(item => ({ numero: item.numero, valorProgramado: item.valorProgramado,
    valorAbonado: item.valorAbonado, saldoPendiente: item.saldoPendiente, estado: item.estado }));
}
function validateActivity(row, financial, snapshot) {
  const signed = [row.contratoAceptadoAt, row.pagareAceptadoAt, row.contratoOtpVerificadoAt,
    row.contratoFirmaDataUrl, row.contratoFotoDataUrl, row.contratoSelfieDataUrl,
    snapshot.firma, financial.selloFinanciero].some(Boolean);
  requireCondition(row.estado === 'GENERADO' && row.pazYSalvoEmitidoAt == null &&
    row.planCapitalVigente == null && !row.deliverableReady && !signed &&
    row.principal_revision_count === 0 && row.amortization_count === 0 &&
    row.intent_count === 0 && row.signature_process_count === 0 && row.approval_review_count === 0,
    'Un crédito tiene firma, cierre, revisión, amortización o transacciones; revise su estado actual.');
}
function validatePayments(row) {
  requireCondition(Array.isArray(row.abonos), 'Falta la revisión de abonos.');
  if (row.id === 777) {
    const payment = row.abonos[0];
    requireCondition(row.abonos.length === 1 && payment?.id === 983 && payment.creditoId === 777 &&
      payment.valor === 450000 && payment.estado === 'ACTIVO' && payment.metodoPago === 'EFECTIVO',
      'El abono revisado del crédito 777 cambió; no se reemplazará su calendario.');
  } else requireCondition(row.abonos.length === 0, 'Los abonos del lote cambiaron desde la revisión.');
}
function planInput(row, firstPayment, frequency) {
  return { montoCredito: row.montoCredito, valorCuota: row.valorCuota, plazoMeses: row.plazoMeses,
    fechaPrimerPago: firstPayment, frecuenciaPago: frequency,
    abonos: row.abonos.filter(item => item.estado !== 'ANULADO').map(item =>
      ({ valor: item.valor, fechaAbono: item.fechaAbono })),
    today: '2026-09-27' };
}

export function planSixMassFixedDates(rows, appliedAt) {
  requireCondition(Array.isArray(rows) && rows.length === 6 && new Set(rows.map(row => row.id)).size === 6,
    'La carga objetivo debe contener exactamente seis créditos.');
  requireCondition(typeof appliedAt === 'string' && !Number.isNaN(Date.parse(appliedAt)),
    'La fecha de auditoría no es válida.');
  const plans = rows.map(row => {
    const target = fixedDatesTargets.find(item => item.id === row.id);
    requireCondition(target, 'Un crédito no pertenece al alcance autorizado.');
    const snapshot = record(row.contratoSnapshot);
    const origin = record(snapshot?.origen);
    const financial = record(snapshot?.financiero);
    const receipt = origin?.importReceipt;
    const imported = receipt?.normalized;
    requireCondition(snapshot && origin && financial && imported &&
      row.equalityService === 'IMPORTACION_MASIVA' && origin.tipo === 'IMPORTACION_MASIVA' &&
      origin.batchId === fixedDatesBatchId && origin.requestId === fixedDatesBatchId &&
      receipt.rowNumber === target.rowNumber && receipt.ok === true &&
      Array.isArray(receipt.errors) && receipt.errors.length === 0 && imported.frecuencia === 'CATORCENAL',
      'El recibo no corresponde a la carga autorizada.');
    requireCondition(row.saldoBaseFinanciado === target.capital && row.valorCuota === target.cuota &&
      row.plazoMeses === target.numeroCuotas && row.montoCredito === target.cuota * target.numeroCuotas &&
      imported.valorCredito === target.capital && imported.cuota === target.cuota && imported.plazo === target.numeroCuotas &&
      financial.saldoBaseFinanciado === target.capital && financial.valorCuota === target.cuota &&
      financial.plazo === target.numeroCuotas && financial.montoCredito === row.montoCredito,
      'Los términos actuales o el recibo original cambiaron desde la revisión.');
    requireCondition(String(row.clienteDocumento ?? '') === String(imported.cedula ?? '') &&
      civilDateKey(row.creditDate) === target.activationDate &&
      civilDateKey(imported.fecha) === target.activationDate &&
      civilDateKey(financial.fechaCredito) === target.activationDate,
      'La identidad o la fecha de activación del crédito no concuerda con el recibo.');
    validateActivity(row, financial, snapshot);
    const components = readMassCreditComponents(snapshot, row);
    requireCondition(components && components.liquidacionAnticipada !== true &&
      components.fianzaPorcentaje === 75 && components.seguroCuotaPorcentaje === 0.03 &&
      row.tasaInteresEa === 0 && row.fianzaPorcentaje === 75 && financial.fianzaPorcentaje === 75 &&
      financial.seguroCuotaPorcentaje === 0.03 && financial.valorFianza === components.fianza &&
      financial.valorSeguro === components.seguro && financial.valorInteres === components.intereses,
      'El desglose financiero corregido no concilia; no se alterará.');
    validatePayments(row);
    const correctedFirstPayment = policyFirstPaymentDate(target.activationDate);
    requireCondition(civilDateKey(imported.fechaPago) === correctedFirstPayment &&
      civilDateKey(row.firstPaymentDate) === correctedFirstPayment &&
      civilDateKey(financial.fechaPrimerPago) === correctedFirstPayment,
      'El primer pago original no coincide con la política revisada.');
    const marker = origin.fixedPaymentCalendarCorrection;
    const replay = marker !== undefined;
    if (replay) {
      requireCondition(marker?.key === fixedDatesCorrectionKey && marker.policy === fixedDatesPolicy &&
        marker.source === 'CSV_FECHA' && marker.activationDate === target.activationDate &&
        marker.before?.frequency === 'CATORCENAL' && marker.after?.frequency === 'QUINCENAL' &&
        marker.after?.firstPayment === correctedFirstPayment &&
        row.frecuenciaPago === 'QUINCENAL' && financial.frecuenciaPago === 'QUINCENAL',
        'Existe una corrección de calendario diferente o incompleta.');
    } else requireCondition(row.frecuenciaPago === 'CATORCENAL' && financial.frecuenciaPago === 'CATORCENAL',
      'La frecuencia actual cambió desde la revisión.');
    const previousPlan = buildCreditPaymentPlan(planInput(row, row.firstPaymentDate, row.frecuenciaPago));
    requireCondition(previousPlan.nextInstallment?.saldoPendiente > 0 &&
      civilDateKey(row.nextPaymentDate) === previousPlan.nextInstallment.fechaVencimiento,
      'Existe un vencimiento administrativo distinto del calendario; no se sobrescribirá.');
    const correctedPlan = buildCreditPaymentPlan(planInput(row, correctedFirstPayment, 'QUINCENAL'));
    requireCondition(canonical(paymentAllocation(previousPlan)) === canonical(paymentAllocation(correctedPlan)) &&
      previousPlan.totalPaid === correctedPlan.totalPaid && previousPlan.saldoPendiente === correctedPlan.saldoPendiente &&
      correctedPlan.installments.every(item => ['02', '17'].includes(item.fechaVencimiento.slice(-2))),
      'La corrección cambió importes o la asignación de pagos a cuotas.');
    const correctedNextPayment = correctedPlan.nextInstallment.fechaVencimiento;
    if (replay) {
      requireCondition(marker.after.nextPayment === correctedNextPayment &&
        civilDateKey(row.nextPaymentDate) === correctedNextPayment,
        'La corrección persistida no coincide con el próximo vencimiento.');
      return { id: row.id, changed: false, snapshot, firstPayment: correctedFirstPayment,
        nextPayment: correctedNextPayment, previousPlan, correctedPlan };
    }
    const nextSnapshot = { ...snapshot, financiero: { ...financial, frecuenciaPago: 'QUINCENAL',
      fechaPrimerPago: `${correctedFirstPayment}T12:00:00.000Z` },
    origen: { ...origin, fixedPaymentCalendarCorrection: {
      key: fixedDatesCorrectionKey, policy: fixedDatesPolicy, source: 'CSV_FECHA',
      activationDate: target.activationDate, appliedAt,
      before: { frequency: row.frecuenciaPago, firstPayment: civilDateKey(row.firstPaymentDate),
        nextPayment: civilDateKey(row.nextPaymentDate), snapshotFirstPayment: financial.fechaPrimerPago },
      after: { frequency: 'QUINCENAL', firstPayment: correctedFirstPayment, nextPayment: correctedNextPayment },
      payments: row.abonos.map(item => ({ id: item.id, valor: item.valor, estado: item.estado })),
      motivo: 'Corrección autorizada del calendario a los días 02 y 17; importes y abonos conservados.',
    } } };
    requireCondition(canonical(nextSnapshot.financiero.componentesMasivos) === canonical(financial.componentesMasivos) &&
      canonical(nextSnapshot.origen.importReceipt) === canonical(origin.importReceipt),
      'La corrección modificó el recibo o el marcador financiero.');
    return { id: row.id, changed: true, snapshot: nextSnapshot,
      firstPayment: correctedFirstPayment, nextPayment: correctedNextPayment, previousPlan, correctedPlan };
  });
  requireCondition(plans.every(plan => plan.changed) || plans.every(plan => !plan.changed),
    'Se detectó una corrección parcial; no se aplicarán cambios adicionales.');
  return plans;
}
