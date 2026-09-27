// Bound to the six-row import explicitly authorized for component correction.
import { calculateMassCreditComponents, readMassCreditComponents } from '../lib/mass-credit-financial-components.ts';

export const correctionBatchId = '6107be68-cdcb-4b97-b1d9-64b0c77a4e31';
export const correctionKey = 'MASS_COMPONENTS_SIX_20260927_V1';
export const correctionTargets = Object.freeze([
  [775, 1400000, 152750, 17], [776, 2800000, 119350, 48],
  [777, 1680000, 157250, 20], [778, 1800000, 154100, 22],
  [779, 2800000, 157050, 35], [780, 3440000, 146750, 48],
].map(([id, capital, cuota, numeroCuotas]) => Object.freeze({ id, capital, cuota, numeroCuotas })));

export class CorrectionBlocked extends Error {}
function requireCondition(value, message) {
  if (!value) throw new CorrectionBlocked(message);
}

export function planMassComponentCorrection(rows, settings, appliedAt) {
  requireCondition(settings.fianzaTotalPorcentaje === 75 && settings.seguroCuotaPorcentaje === 0.03,
    'Los parámetros vigentes no coinciden con el ajuste autorizado.');
  requireCondition(rows.length === 6 && new Set(rows.map(row => row.id)).size === 6,
    'La carga objetivo debe contener exactamente seis créditos.');
  const plans = rows.map(row => {
    const target = correctionTargets.find(item => item.id === row.id);
    requireCondition(target, 'Un crédito no pertenece al alcance autorizado.');
    const snapshot = row.contratoSnapshot;
    const imported = snapshot?.origen?.importReceipt?.normalized;
    const financial = snapshot?.financiero;
    requireCondition(snapshot?.origen?.tipo === 'IMPORTACION_MASIVA' && snapshot?.origen?.batchId === correctionBatchId,
      'El recibo no corresponde a la carga autorizada.');
    requireCondition(row.saldoBaseFinanciado === target.capital && row.valorCuota === target.cuota &&
      row.plazoMeses === target.numeroCuotas && row.montoCredito === target.cuota * target.numeroCuotas &&
      imported?.valorCredito === target.capital && imported?.cuota === target.cuota && imported?.plazo === target.numeroCuotas &&
      financial?.saldoBaseFinanciado === target.capital && financial?.valorCuota === target.cuota &&
      financial?.plazo === target.numeroCuotas && financial?.montoCredito === row.montoCredito,
      'Los términos actuales o el recibo original no coinciden con la carga autorizada.');
    requireCondition(row.estado === 'GENERADO' && row.planCapitalVigente == null && row.pazYSalvoEmitidoAt == null &&
      row.contratoAceptadoAt == null && row.pagareAceptadoAt == null && row.contratoOtpVerificadoAt == null && !row.contratoFirmaDataUrl &&
      !snapshot.firma && !financial.selloFinanciero &&
      row.payment_count === 0 && row.principal_revision_count === 0 && row.amortization_count === 0 && row.intent_count === 0,
      'Un crédito tiene pagos, firma, revisión, amortización o transacciones; se requiere revisar el estado actual.');
    const components = calculateMassCreditComponents({ ...target, fianzaPorcentaje: 75, seguroCuotaPorcentaje: 0.03 });
    const existing = readMassCreditComponents(snapshot, row);
    if (existing) {
      requireCondition(financial.componentesMasivos?.auditoria?.correctionKey === correctionKey &&
        existing.fianza === components.fianza && existing.seguro === components.seguro &&
        existing.intereses === components.intereses && row.fianzaPorcentaje === 75 &&
        financial.valorFianza === components.fianza && financial.fianzaPorcentaje === 75 &&
        financial.valorInteres === components.intereses && financial.valorSeguro === components.seguro &&
        financial.seguroCuotaPorcentaje === 0.03,
        'Existe un marcador de componentes distinto del ajuste autorizado.');
      return { id: row.id, components, changed: false, snapshot };
    }
    requireCondition(!financial.componentesMasivos && row.valorFianza === 0 && row.fianzaPorcentaje === 0 &&
      row.valorInteres === row.montoCredito - row.saldoBaseFinanciado && row.tasaInteresEa === 0,
      'El desglose fue modificado desde la revisión; no se sobrescribirá.');
    return {
      id: row.id, components, changed: true,
      snapshot: {
        ...snapshot,
        financiero: {
          ...financial,
          fianzaPorcentaje: 75, valorFianza: components.fianza,
          seguroCuotaPorcentaje: 0.03, valorSeguro: components.seguro,
          valorInteres: components.intereses,
          componentesMasivos: {
            ...components,
            auditoria: {
              correctionKey, appliedAt,
              motivo: 'Reclasificación autorizada exclusivamente para los seis créditos de la última carga; capital y cuota conservados.',
              anterior: { valorFianza: row.valorFianza, fianzaPorcentaje: row.fianzaPorcentaje, valorInteres: row.valorInteres,
                financiero: financial },
            },
          },
        },
      },
    };
  });
  requireCondition(plans.every(plan => plan.changed) || plans.every(plan => !plan.changed),
    'Se detectó un ajuste parcial. No se aplicarán cambios adicionales.');
  return plans;
}