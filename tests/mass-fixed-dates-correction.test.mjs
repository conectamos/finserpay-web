import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { fixedDatesBatchId, fixedDatesCorrectionKey, fixedDatesTargets,
  civilDateKey, policyFirstPaymentDate, planSixMassFixedDates } from '../scripts/mass-fixed-dates-correction-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const { calculateMassCreditComponents, readMassCreditComponents } = await jiti.import('../lib/mass-credit-financial-components.ts');
const auditAt = '2026-09-27T13:00:00.000Z';
function fixtures() {
  return fixedDatesTargets.map(target => {
    const components = calculateMassCreditComponents({ ...target, fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03 });
    const first = policyFirstPaymentDate(target.activationDate);
    return {
      id: target.id, clienteDocumento: `TEST${target.id}`, estado: 'GENERADO', equalityService: 'IMPORTACION_MASIVA',
      saldoBaseFinanciado: target.capital, valorCuota: target.cuota, plazoMeses: target.numeroCuotas,
      montoCredito: components.total, valorInteres: components.intereses, valorFianza: components.fianza,
      fianzaPorcentaje: 75, tasaInteresEa: 0, cuotaInicial: 0,
      frecuenciaPago: 'CATORCENAL', creditDate: target.activationDate, firstPaymentDate: first,
      nextPaymentDate: target.id === 777 ? '2026-10-15' : first,
      planCapitalVigente: null, pazYSalvoEmitidoAt: null, deliverableReady: false,
      contratoAceptadoAt: null, pagareAceptadoAt: null, contratoFirmaDataUrl: null, contratoOtpVerificadoAt: null,
      principal_revision_count: 0, amortization_count: 0, intent_count: 0, signature_process_count: 0, approval_review_count: 0,
      abonos: target.id === 777 ? [{ id: 983, creditoId: 777, valor: 450000, estado: 'ACTIVO',
        metodoPago: 'EFECTIVO', observacion: 'Abono normal', fechaAbono: '2026-09-27T11:00:00.000Z' }] : [],
      contratoSnapshot: {
        cliente: { preservar: 'cliente' }, asignacion: { preservar: 'sede y vendedor' }, equipo: { preservar: 'IMEI' },
        origen: { tipo: 'IMPORTACION_MASIVA', batchId: fixedDatesBatchId, requestId: fixedDatesBatchId,
          requestHash: 'hash-immutable', firstPaymentCorrection: { policy: 'older-audit', preserve: true },
          importReceipt: { rowNumber: target.rowNumber, ok: true, errors: [], normalized: {
            cedula: `TEST${target.id}`, fecha: `${target.activationDate}T12:00:00.000Z`, fechaPago: `${first}T12:00:00.000Z`,
            valorCredito: target.capital, cuota: target.cuota, plazo: target.numeroCuotas, frecuencia: 'CATORCENAL',
          } } },
        financiero: { saldoBaseFinanciado: target.capital, montoCredito: components.total,
          valorCuota: target.cuota, plazo: target.numeroCuotas, frecuenciaPago: 'CATORCENAL',
          fechaCredito: `${target.activationDate}T12:00:00.000Z`, fechaPrimerPago: `${first}T12:00:00.000Z`,
          valorInteres: components.intereses, valorFianza: components.fianza, valorSeguro: components.seguro,
          fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03,
          componentesMasivos: { ...components, auditoria: { correctionKey: 'MASS_COMPONENTS_SIX_20260927_V1',
            anterior: { valorFianza: 0, valorInteres: components.total - target.capital } } } },
      },
    };
  });
}
function applyPlans(rows, plans) {
  return rows.map(row => {
    const plan = plans.find(item => item.id === row.id);
    return { ...row, contratoSnapshot: plan.snapshot, frecuenciaPago: 'QUINCENAL',
      firstPaymentDate: plan.firstPayment, nextPaymentDate: plan.nextPayment };
  });
}

test('corrects only six calendars, preserving terms, receipts, component markers and other snapshots', () => {
  const rows = fixtures(); const before = structuredClone(rows);
  const plans = planSixMassFixedDates(rows, auditAt);
  assert.equal(plans.length, 6);
  assert.ok(plans.every(plan => plan.changed));
  for (const plan of plans) {
    const row = before.find(item => item.id === plan.id);
    assert.deepEqual(plan.snapshot.financiero.componentesMasivos, row.contratoSnapshot.financiero.componentesMasivos);
    assert.ok(readMassCreditComponents(plan.snapshot, row));
    const expected = structuredClone(row.contratoSnapshot);
    expected.financiero.frecuenciaPago = 'QUINCENAL';
    expected.financiero.fechaPrimerPago = `${plan.firstPayment}T12:00:00.000Z`;
    expected.origen.fixedPaymentCalendarCorrection = plan.snapshot.origen.fixedPaymentCalendarCorrection;
    assert.deepEqual(plan.snapshot, expected);
    assert.equal(plan.snapshot.origen.fixedPaymentCalendarCorrection.key, fixedDatesCorrectionKey);
    assert.ok(plan.correctedPlan.installments.every(item => ['02', '17'].includes(item.fechaVencimiento.slice(-2))));
    assert.equal(plan.correctedPlan.saldoPendiente, plan.previousPlan.saldoPendiente);
    for (const [index, quota] of plan.correctedPlan.installments.entries()) {
      const old = plan.previousPlan.installments[index];
      for (const field of ['numero', 'valorProgramado', 'valorAbonado', 'saldoPendiente', 'estado']) {
        assert.equal(quota[field], old[field]);
      }
    }
  }
  assert.deepEqual(rows, before, 'planning must not mutate input');
  assert.equal(plans.find(plan => plan.id === 780).firstPayment, '2026-10-02');
  assert.equal(plans.find(plan => plan.id === 780).nextPayment, '2026-10-02');
});

test('450000 already paid retains two paid quotas and the third partial quota, moving October 15 to October 17', () => {
  const plan = planSixMassFixedDates(fixtures(), auditAt).find(item => item.id === 777);
  assert.equal(plan.previousPlan.nextInstallment.fechaVencimiento, '2026-10-15');
  assert.equal(plan.nextPayment, '2026-10-17');
  assert.equal(plan.correctedPlan.paidCount, 2);
  assert.equal(plan.correctedPlan.totalPaid, 450000);
  assert.equal(plan.correctedPlan.saldoPendiente, 2695000);
  assert.equal(plan.correctedPlan.nextInstallment.numero, 3);
  assert.equal(plan.correctedPlan.nextInstallment.valorAbonado, 135500);
  assert.equal(plan.correctedPlan.nextInstallment.saldoPendiente, 21750);
  assert.deepEqual(plan.correctedPlan.installments.slice(0, 3).map(item => item.fechaVencimiento),
    ['2026-09-17', '2026-10-02', '2026-10-17']);
});

test('a complete correction is idempotent and preserves its original audit timestamp', () => {
  const rows = fixtures(); const plans = planSixMassFixedDates(rows, auditAt);
  const applied = applyPlans(rows, plans);
  const replay = planSixMassFixedDates(applied, '2026-09-27T14:00:00.000Z');
  assert.ok(replay.every(plan => !plan.changed));
  for (const plan of replay) assert.equal(plan.snapshot.origen.fixedPaymentCalendarCorrection.appliedAt, auditAt);
});

test('activation policy handles the boundaries, end of year, civil midnight and host timezone independently', () => {
  for (const [from, expected] of [
    ['2026-09-01', '2026-09-17'], ['2026-09-05', '2026-09-17'],
    ['2026-09-06', '2026-10-02'], ['2026-09-20', '2026-10-02'],
    ['2026-09-21', '2026-10-17'], ['2026-12-31', '2027-01-17'],
    ['2027-02-20', '2027-03-02'], ['2026-09-06T00:00:00.000Z', '2026-10-02'],
  ]) assert.equal(policyFirstPaymentDate(from), expected);
  assert.equal(civilDateKey(new Date('2026-09-06T00:00:00.000Z')), '2026-09-06');
  assert.throws(() => civilDateKey('2026-02-30'), /civil/);
});

test('custom due overrides, changed receipts, financial terms and changed payment activity block the correction', () => {
  for (const mutate of [
    rows => { rows[2].nextPaymentDate = '2026-10-16'; },
    rows => { rows[0].contratoSnapshot.origen.importReceipt.normalized.valorCredito++; },
    rows => { rows[0].valorCuota++; },
    rows => { rows[0].creditDate = '2026-09-03'; },
    rows => { rows[2].abonos[0].valor++; },
    rows => { rows[2].abonos[0].estado = 'ANULADO'; },
    rows => { rows[0].abonos.push({ id: 999, valor: 1, estado: 'ACTIVO' }); },
  ]) {
    const rows = fixtures(); mutate(rows);
    assert.throws(() => planSixMassFixedDates(rows, auditAt));
  }
});

test('signed, amortized, revised, settled and pending transaction records block the correction', () => {
  for (const field of ['contratoAceptadoAt', 'pagareAceptadoAt', 'contratoFirmaDataUrl', 'contratoOtpVerificadoAt',
    'contratoFotoDataUrl', 'contratoSelfieDataUrl', 'pazYSalvoEmitidoAt', 'planCapitalVigente']) {
    const rows = fixtures(); rows[0][field] = 'existing';
    assert.throws(() => planSixMassFixedDates(rows, auditAt), /firma, cierre/);
  }
  for (const field of ['principal_revision_count', 'amortization_count', 'intent_count', 'signature_process_count', 'approval_review_count']) {
    const rows = fixtures(); rows[0][field] = 1;
    assert.throws(() => planSixMassFixedDates(rows, auditAt), /firma, cierre/);
  }
  const signed = fixtures(); signed[0].contratoSnapshot.firma = { signed: true };
  assert.throws(() => planSixMassFixedDates(signed, auditAt), /firma, cierre/);
  const sealed = fixtures(); sealed[0].contratoSnapshot.financiero.selloFinanciero = { locked: true };
  assert.throws(() => planSixMassFixedDates(sealed, auditAt), /firma, cierre/);
});

test('foreign credits and batches, invalid component markers and partial corrections are rejected', () => {
  assert.throws(() => planSixMassFixedDates(fixtures().slice(0, 5), auditAt), /seis/);
  const outside = fixtures(); outside[0].id = 614;
  assert.throws(() => planSixMassFixedDates(outside, auditAt), /alcance/);
  const batch = fixtures(); batch[0].contratoSnapshot.origen.batchId = 'other';
  assert.throws(() => planSixMassFixedDates(batch, auditAt), /carga autorizada/);
  const marker = fixtures(); marker[0].contratoSnapshot.financiero.componentesMasivos.seguro++;
  assert.throws(() => planSixMassFixedDates(marker, auditAt), /desglose/);
  const rows = fixtures(); const plans = planSixMassFixedDates(rows, auditAt);
  const applied = applyPlans(rows, plans); applied[0] = rows[0];
  assert.throws(() => planSixMassFixedDates(applied, auditAt), /parcial/);
});
