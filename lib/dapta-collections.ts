import "server-only";
import { createCollectionsHandlers } from "@/lib/dapta-collections-http";
import { createMoraManagement, getMoraManagement, parseMoraManagement } from "@/lib/analyst-mora-management";
import { approvalErrorResponse } from "@/lib/credit-approval-http";

export const collectionsHandlers = createCollectionsHandlers({
  token: () => process.env.FINSERPAY_COBRANZA_API_TOKEN,
  agentId: () => process.env.FINSERPAY_COBRANZA_AGENT_ID,
  actorId: () => Number(process.env.FINSERPAY_COBRANZA_ACTOR_ID),
  read: async id => {
    const { credit, history } = await getMoraManagement(id);
    const latest = history[0] || null;
    return {
      consultadoAt: new Date().toISOString(), moneda: "COP",
      credito: { id: credit.id, numero: credit.numeroCreditoVisible, folio: credit.folio,
        valorVencido: credit.valorVencido, diasMora: credit.diasMora, ultimoPago: credit.ultimoPago, enMora: credit.enMora },
      ultimaGestion: latest,
      acuerdoVigente: latest?.managementStatus === "ACUERDO_PAGO",
      suspenderCobranza: !credit.enMora || latest?.managementStatus === "ACUERDO_PAGO" || latest?.resultCode === "PAGO_REALIZADO",
      // This portfolio has no authoritative legal-stage fields. Unknown is not false.
      bloqueoAplica: null, reporteHabilitado: null, reporteConfirmado: null,
      trasladoPrejuridico: null, evaluacionJudicialDecidida: null,
    };
  },
  record: async (id, input, actorId) => createMoraManagement(id, parseMoraManagement(input), {
    id: actorId, nombre: "Integración Dapta cobranza", centralAdmin: false,
  }),
  error: approvalErrorResponse,
});
