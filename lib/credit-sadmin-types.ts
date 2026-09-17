export type SadminRegistration = {
  version: number;
  codeudorCreado: boolean;
  creditoCreado: boolean;
  numeroCreditoConfirmado: boolean;
  numeroCredito: string | null;
  estado: "PENDIENTE" | "CREADO_SADMIN";
  updatedAt: string | null;
  completedAt: string | null;
};

export type SadminCreditRow = {
  id: number;
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
  diasVencidos: number;
  ultimoPago: string | null;
  sadmin: SadminRegistration;
};

export type SadminPage = {
  items: SadminCreditRow[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
};
