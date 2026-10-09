export const MORA_ACTIONS = ["LLAMADA", "MSJ_TEXTO"] as const;
export const MORA_MANAGEMENT_STATES = ["CONTACTADO", "SIN_RESPUESTA", "ACUERDO_PAGO", "CERRADO", "SOLUCIONADO", "SEGUIMIENTO"] as const;
export const MORA_RESULTS = ["MEDIOS_PAGO", "NUMERO_SIN_WHATSAPP", "SIN_RESPUESTA", "ACUERDO_PAGO", "PAGO_REALIZADO", "VISITA_PENDIENTE", "PRORROGA_APROBADA"] as const;
export type MoraManagementResult = typeof MORA_RESULTS[number];
export const MORA_RESULT_LABELS: Record<MoraManagementResult, string> = {
  ACUERDO_PAGO: "Acuerdo de pago",
  PAGO_REALIZADO: "Ya realizó el pago",
  SIN_RESPUESTA: "No contesta",
  VISITA_PENDIENTE: "Visita pendiente",
  PRORROGA_APROBADA: "Prórroga aprobada 4 días",
  MEDIOS_PAGO: "Medios de pago",
  NUMERO_SIN_WHATSAPP: "Número sin WhatsApp",
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
export type MoraPortfolioItem = { id: number; folio: string; numeroCreditoVisible: string; clienteNombre: string; clienteDocumento: string | null; aliadoId: number; aliadoNombre: string; equipo: string; imei: string | null; valorVencido: number; diasMora: number; ultimoPago: string | null; fechaCredito: string; ultimaGestion: MoraManagementEvent | null };
