export const MORA_ACTIONS = ["LLAMADA", "MSJ_TEXTO"] as const;
export const MORA_MANAGEMENT_STATES = ["CONTACTADO", "SIN_RESPUESTA", "ACUERDO_PAGO", "CERRADO", "SOLUCIONADO", "SEGUIMIENTO"] as const;
// Prórroga is derived from an approved, current request; it is never a manual
// management choice and does not overwrite the recorded follow-up history.
export const MORA_PORTFOLIO_STATES = [...MORA_MANAGEMENT_STATES, "PRORROGA"] as const;
export const CREDIT_PORTFOLIO_STATES = ["EN_MORA", "AL_DIA", "PAGADO", "ANULADO"] as const;
export type CreditPortfolioState = typeof CREDIT_PORTFOLIO_STATES[number];
export const MORA_RESULTS = ["MEDIOS_PAGO", "NUMERO_SIN_WHATSAPP", "SIN_RESPUESTA", "ACUERDO_PAGO", "PAGO_REALIZADO", "VISITA_PENDIENTE", "PRORROGA_APROBADA", "LLAMADA_INCOMPLETA"] as const;
export const CREDIT_MANAGEMENT_RESULTS = [...MORA_RESULTS, "RECORDATORIO_PAGO"] as const;
export type MoraManagementResult = typeof CREDIT_MANAGEMENT_RESULTS[number];
export const MORA_RESULT_LABELS: Record<MoraManagementResult, string> = {
  ACUERDO_PAGO: "Acuerdo de pago",
  PAGO_REALIZADO: "Ya realizó el pago",
  SIN_RESPUESTA: "No contesta",
  VISITA_PENDIENTE: "Visita pendiente",
  PRORROGA_APROBADA: "Prórroga aprobada 4 días",
  MEDIOS_PAGO: "Medios de pago",
  NUMERO_SIN_WHATSAPP: "Número sin WhatsApp",
  LLAMADA_INCOMPLETA: "Llamada incompleta",
  RECORDATORIO_PAGO: "Recordatorio de pago",
};
export function moraResultsForAction(action: typeof MORA_ACTIONS[number]): readonly MoraManagementResult[] {
  void action;
  return MORA_RESULTS;
}
export function moraResultLabel(result: MoraManagementResult, action: typeof MORA_ACTIONS[number]) {
  void action;
  return MORA_RESULT_LABELS[result];
}

export type MoraManagementInput = {
  action: typeof MORA_ACTIONS[number];
  actedAt: string;
  responsibleUserId: number;
  result: MoraManagementResult;
  agreementDate?: string | null;
  agreementAmount?: number | null;
  comment: string;
  nextFollowUpAt: string;
  managementStatus: typeof MORA_MANAGEMENT_STATES[number];
  idempotencyKey: string;
};

// Stored history keeps its original descriptions, including retired choices.
export type MoraManagementEvent = Omit<MoraManagementInput, "action" | "managementStatus" | "result" | "agreementDate" | "agreementAmount"> & {
  id: string;
  creditoId: number;
  action: string;
  managementStatus: string;
  result: string;
  resultCode: MoraManagementResult | null;
  agreementDate: string | null;
  agreementAmount: number | null;
  responsibleName: string;
  actorUserId: number;
  actorName: string;
  createdAt: string;
};
export type MoraActiveExtension = {
  id: string;
  expiresOn: string | null;
  reason: string;
  approvedAt: string | null;
  approvedByName: string | null;
  installmentNumber: number | null;
  installmentDueDate: string | null;
};
export type MoraPortfolioItem = { id: number; folio: string; numeroCreditoVisible: string; clienteNombre: string; clienteDocumento: string | null; aliadoId: number; aliadoNombre: string; equipo: string; imei: string | null; valorVencido: number; diasMora: number; ultimoPago: string | null; fechaCredito: string; ultimaGestion: MoraManagementEvent | null; prorrogaActiva: MoraActiveExtension | null; estadoGestion: string; estadoCartera?: CreditPortfolioState; saldoPendiente?: number; fechaProximoPago?: string | null };
