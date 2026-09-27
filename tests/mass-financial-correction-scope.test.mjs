import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionBatchId, correctionKey, correctionTargets, planMassComponentCorrection }
  from '../scripts/mass-financial-correction-core.mjs';
const settings = { fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03 };
function originals() {
  return correctionTargets.map(target => ({
    id: target.id, saldoBaseFinanciado: target.capital, valorCuota: target.cuota,
    plazoMeses: target.numeroCuotas, montoCredito: target.cuota * target.numeroCuotas,
    valorFianza: 0, fianzaPorcentaje: 0, valorInteres: target.cuota * target.numeroCuotas - target.capital,
    tasaInteresEa: 0, estado: 'GENERADO', planCapitalVigente: null, pazYSalvoEmitidoAt: null,
    contratoAceptadoAt: null, pagareAceptadoAt: null, contratoFirmaDataUrl: null,
    payment_count: 0, principal_revision_count: 0, amortization_count: 0, intent_count: 0,
    fechaCredito: '2026-09-02', fechaPrimerPago: '2026-09-17',
    contratoSnapshot: { cliente: { marker: 'preservar' }, origen: { tipo: 'IMPORTACION_MASIVA', batchId: correctionBatchId,
      importReceipt: { normalized: { valorCredito: target.capital, cuota: target.cuota, plazo: target.numeroCuotas } } },
      financiero: { saldoBaseFinanciado: target.capital, valorCuota: target.cuota,
        plazo: target.numeroCuotas, montoCredito: target.cuota * target.numeroCuotas, fechaPrimerPago: '2026-09-17' } },
  }));
}
test('corrects exactly six, freezes imported terms and preserves source/customer/calendar', () => {
  const rows = originals(); const copy = structuredClone(rows);
  const plans = planMassComponentCorrection(rows, settings, '2026-09-27T09:00:00Z');
  assert.equal(plans.length, 6);
  for (const plan of plans) {
    const row = copy.find(row => row.id === plan.id);
    assert.equal(plan.components.total, row.montoCredito);
    assert.equal(plan.components.capital, row.saldoBaseFinanciado);
    assert.equal(plan.components.cuota, row.valorCuota);
    assert.equal(plan.components.numeroCuotas, row.plazoMeses);
    assert.deepEqual(plan.snapshot.origen, row.contratoSnapshot.origen);
    assert.deepEqual(plan.snapshot.cliente, row.contratoSnapshot.cliente);
    assert.equal(plan.snapshot.financiero.fechaPrimerPago, '2026-09-17');
    assert.equal(plan.snapshot.financiero.componentesMasivos.auditoria.correctionKey, correctionKey);
  }
  assert.deepEqual(rows, copy);
});
test('idempotent complete correction writes nothing', () => {
  const rows = originals(); const plans = planMassComponentCorrection(rows, settings, 'date');
  rows.forEach((row, i) => Object.assign(row, { contratoSnapshot: plans[i].snapshot,
    valorInteres: plans[i].components.intereses, valorFianza: plans[i].components.fianza, fianzaPorcentaje: 75 }));
  assert.equal(planMassComponentCorrection(rows, settings, 'later').filter(row => row.changed).length, 0);
});
test('blocks partial correction and changed scope', () => {
  const rows = originals(); const plans = planMassComponentCorrection(rows, settings, 'date');
  Object.assign(rows[0], { contratoSnapshot: plans[0].snapshot, valorInteres: plans[0].components.intereses,
    valorFianza: plans[0].components.fianza, fianzaPorcentaje: 75 });
  assert.throws(() => planMassComponentCorrection(rows, settings, 'date'), /parcial/);
  assert.throws(() => planMassComponentCorrection(originals().slice(0,5), settings, 'date'), /seis/);
  const outside = originals(); outside[0].id=614;
  assert.throws(() => planMassComponentCorrection(outside, settings, 'date'), /alcance/);
  const batch = originals(); batch[0].contratoSnapshot.origen.batchId='other';
  assert.throws(() => planMassComponentCorrection(batch, settings, 'date'), /carga autorizada/);
});
test('blocks activity, signed terms, rate change and original receipt mismatch', () => {
  for (const field of ['payment_count','principal_revision_count','amortization_count','intent_count']) {
    const rows = originals(); rows[0][field]=1;
    assert.throws(() => planMassComponentCorrection(rows, settings, 'date'), /pagos, firma/);
  }
  for (const field of ['contratoAceptadoAt','pagareAceptadoAt','contratoOtpVerificadoAt','contratoFirmaDataUrl','planCapitalVigente']) {
    const rows = originals(); rows[0][field]='existing';
    assert.throws(() => planMassComponentCorrection(rows, settings, 'date'), /pagos, firma/);
  }
  for (const seal of ['firma', 'selloFinanciero']) {
    const rows = originals();
    if (seal === 'firma') rows[0].contratoSnapshot.firma = { existente: true };
    else rows[0].contratoSnapshot.financiero.selloFinanciero = { existente: true };
    assert.throws(() => planMassComponentCorrection(rows, settings, 'date'), /pagos, firma/);
  }
  assert.throws(() => planMassComponentCorrection(originals(), { ...settings, seguroCuotaPorcentaje: 0.3 }, 'date'), /parámetros/);
  const mismatch = originals(); mismatch[0].contratoSnapshot.origen.importReceipt.normalized.valorCredito+=1;
  assert.throws(() => planMassComponentCorrection(mismatch, settings, 'date'), /términos/);
});