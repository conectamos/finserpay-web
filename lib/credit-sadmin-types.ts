import type { ApprovalActor } from "@/lib/credit-approval-actor";

export type SadminCreationStatus =
  | "PENDIENTE_CREAR"
  | "CREADO_CORRECTAMENTE"
  | "ERROR_CREACION"
  | "REQUIERE_REVISION";

export type SadminAccessScope = "HISTORICAL";
export type SadminActor = ApprovalActor & {
  sadminScope: SadminAccessScope;
  sadminWriteScope?: SadminAccessScope;
};

export type SadminRegistration = {
  version: number;
  codeudorCreado: boolean;
  creditoCreado: boolean;
  numeroCreditoConfirmado: boolean;
  numeroCredito: string | null;
  estado: "PENDIENTE" | "CREADO_SADMIN";
  estadoCreacion: SadminCreationStatus;
  motivoEstado: string | null;
  updatedAt: string | null;
  completedAt: string | null;
};

export type SadminHistoryEntry = {
  version: number;
  actor: string;
  fechaHora: string;
  numeroCredito: string | null;
  resultado: SadminCreationStatus;
  motivo: string | null;
};

export type SadminSummary = {
  creditoId: number;
  canEditSadmin: boolean;
  folio: string;
  numeroCreditoVisible: string;
  registroLocalHref: string;
  sadmin: SadminRegistration;
  historial: SadminHistoryEntry[];
};

export type SadminStatusFilter = "all" | "pending" | "created";

export type SadminCreditRow = {
  id: number;
  canEditSadmin: boolean;
  folio: string;
  numeroCreditoVisible: string;
  createdAt: string;
  fechaCredito: string | null;
  clienteNombre: string;
  clienteDocumento: string;
  clienteTelefono: string;
  clienteDireccion: string;
  clienteFechaNacimiento: string | null;
  clienteCorreo: string;
  clienteGenero: string;
  imei: string;
  referenciaEquipo: string;
  numeroCuotas: number;
  frecuenciaPago: string;
  valorVenta: number;
  cuotaInicial: number;
  creditoAutorizado: number;
  valorCuota: number;
  interesMensual: number | null;
  fianza: number | null;
  seguro: number | null;
  aliadoNombre: string;
  sedeNombre: string;
  fechaProximoPago: string | null;
  cuotasPagadas: number;
  cuotasPendientes: number;
  saldoObligacion: number;
  saldoCapital: number;
  saldoFianza: number;
  saldoIntereses: number;
  saldoSeguro?: number;
  diasVencidos: number;
  ultimoPago: string | null;
  registroLocalHref: string;
  sadmin: SadminRegistration;
};

export type SadminPage = {
  items: SadminCreditRow[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
  counts: {
    all: number;
    pending: number;
    created: number;
  };
};
