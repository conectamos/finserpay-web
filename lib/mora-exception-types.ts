export type MoraExceptionType = "EXCEPCION" | "PRORROGA";
export type MoraExceptionStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "REPLACED";
export type MoraPromiseConditionStatus = "NOT_APPLICABLE" | "PENDING" | "FULFILLED" | "BREACHED";

export type MoraExceptionRequestItem = {
  id: string;
  creditoId: number;
  type: MoraExceptionType;
  status: MoraExceptionStatus;
  version: number;
  source: "ANALYST_REQUEST" | "CENTRAL_DIRECT";
  centralDirect: boolean;
  installmentNumber: number | null;
  installmentDueDate: string | null;
  expiresOn: string | null;
  promiseAmount: number | null;
  promiseDate: string | null;
  reason: string;
  observation: string;
  createdByUserId: number;
  createdByName: string;
  submittedAt: string;
  decidedByUserId: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  cooldownBypassed: boolean;
  cooldownBypassReason: string | null;
  createdAt: string;
  updatedAt: string;
  credit?: { folio: string; numeroSadmin: string | null; clienteNombre?: string; clienteDocumento?: string | null;
    clienteTelefono?: string | null; equipo?: string; imei?: string | null; aliadoId?: number; aliadoNombre?: string };
  paidTowardPromise: number;
  conditionStatus: MoraPromiseConditionStatus;
};

export type MoraExceptionCreditSummary = {
  id: number;
  folio: string;
  numeroCreditoVisible: string;
  numeroSadmin?: string | null;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  aliadoId: number;
  aliadoNombre: string;
  equipo: string;
  imei: string | null;
  valorVencido: number;
  diasMora: number;
  ultimoPago: string | null;
  fechaCredito: string;
  enMora: boolean;
};

export type MoraExceptionEligibility = {
  regularInstallment: { number: number; dueDate: string; balance: number } | null;
  maxExpiresOn: string | null;
  prorroga: { canRequest: boolean; blockedReason: string | null };
  excepcion: { canRequest: boolean; blockedReason: string | null; cooldownEnabledOn: string | null };
  canBypassCooldown: boolean;
  promise: { amount: number; date: string };
};

export type MoraExceptionEvent = {
  id: string;
  requestId: string;
  creditoId: number;
  version: number;
  action: "SUBMITTED" | "APPROVED" | "REJECTED" | "EXPIRED" | "OBSERVED" | "REPLACED";
  fromStatus: MoraExceptionStatus | null;
  toStatus: MoraExceptionStatus;
  payload: unknown;
  actorUserId: number | null;
  actorName: string;
  createdAt: string;
};

export type MoraExceptionPermissionUser = {
  id: number;
  nombre: string;
};

export type MoraExceptionPermissionGrant = {
  userId: number;
  active: boolean;
  reason: string;
  grantedByName: string;
  updatedAt: string;
};

export type MoraExceptionPermissionEvent = {
  id: string;
  userId: number;
  permissionKey: "MORA_COOLDOWN_BYPASS";
  active: boolean;
  reason: string;
  actorUserId: number;
  actorName: string;
  createdAt: string;
};
