export type SettlementDeliveryChannel = "EMAIL" | "WHATSAPP";
export type SettlementDeliveryPayload = {
  allyName: string;
  periodStart: string;
  periodEnd: string;
  netAmount: string;
  subject: string;
  text: string;
};
export type SettlementDeliveryAttempt = {
  id: string;
  settlementId: number;
  channel: SettlementDeliveryChannel;
  sequence: number;
  recipient: string | null;
  status: "QUEUED" | "PROCESSING" | "SENT" | "FAILED" | "UNCERTAIN";
  payload: SettlementDeliveryPayload;
  error: string | null;
  createdAt: Date;
  attemptedAt: Date | null;
  sentAt: Date | null;
  sendStartedAt: Date | null;
  providerId: string | null;
  claimToken: string;
};
export function buildSettlementDeliveryPayload(input: {
  allyName: string; periodStart: string; periodEnd: string; netAmount: number;
}): SettlementDeliveryPayload {
  // Stored periods are calendar dates, never shift them through a local timezone.
  const formatDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Período de liquidación inválido.");
    return value.split("-").reverse().join("/");
  };
  if (!Number.isFinite(input.netAmount)) throw new Error("Valor neto inválido.");
  const periodStart = formatDate(input.periodStart);
  const periodEnd = formatDate(input.periodEnd);
  const netAmount = new Intl.NumberFormat("es-CO", {
    style: "currency", currency: "COP", maximumFractionDigits: 2,
  }).format(input.netAmount);
  const allyName = input.allyName.replace(/[\r\n]/g, " ").trim();
  return {
    allyName, periodStart, periodEnd, netAmount,
    subject: `FINSER PAY | Liquidación del ${periodStart} al ${periodEnd}`,
    text: `Hola, ${allyName}.\n\nAdjuntamos tu liquidación del ${periodStart} al ${periodEnd}.\nValor neto de la liquidación: ${netAmount}.\n\nEste documento informa la liquidación generada y no confirma un desembolso.\n\nFINSER PAY`,
  };
}
