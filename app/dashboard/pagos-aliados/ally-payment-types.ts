export type AllyOption = {
  id: number;
  nombre: string;
  codigo?: string | null;
  activo?: boolean;
};

export type PaymentCreditItem = {
  numeroCreditoVisible?: string | null;
  id?: number | string;
  creditoId?: number | string;
  fecha?: string | null;
  fechaCredito?: string | null;
  fechaLiquidacion?: string | null;
  folio?: string | null;
  cliente?: string | null;
  clienteNombre?: string | null;
  clienteDocumento?: string | null;
  imei?: string | null;
  equipo?: string | null;
  plataforma?: string | null;
  valorVenta?: number | null;
  creditoAutorizado?: number | null;
  cuotaInicial?: number | null;
  porcentajeIntermediacion?: number | null;
  valorIntermediacion?: number | null;
  valorPagar?: number | null;
  estado?: string | null;
  estadoLiquidacion?: string | null;
  aliado?: AllyOption | null;
  sede?: {
    id?: number | null;
    nombre?: string | null;
  } | null;
};

export type PaymentCollectionItem = {
  aliado?: AllyOption | null;
  plataforma?: string | null;
  imei?: string | null;
  numeroCreditoVisible?: string | null;
  id?: number | string;
  abonoId?: number | string;
  creditoId?: number | string;
  sedeId?: number | string;
  fechaAbono?: string | null;
  folio?: string | null;
  clienteNombre?: string | null;
  clienteDocumento?: string | null;
  sedeNombre?: string | null;
  metodoPago?: string | null;
  valor?: number | null;
  estado?: string | null;
};

export type PaymentSummaryBucket = {
  plataforma?: string | null;
  numeroCreditos?: number | null;
  totalValorVenta?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalPagar?: number | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  saldoNeto?: number | null;
  direccionSaldo?: string | null;
  valorPagarAliado?: number | null;
  valorConsignarAliado?: number | null;
  numeroRecaudos?: number | null;
  porcentajeIntermediacion?: number | null;
  valorVenta?: number | null;
  creditoAutorizado?: number | null;
  cuotaInicial?: number | null;
  valorIntermediacion?: number | null;
  valorPagar?: number | null;
};

export type PaymentSummary = {
  ANDROID?: PaymentSummaryBucket | null;
  IPHONE?: PaymentSummaryBucket | null;
  total?: PaymentSummaryBucket | null;
};

export type Settlement = {
  id: number | string;
  aliadoId?: number | null;
  aliado?: AllyOption | null;
  aliadoNombre?: string | null;
  periodoInicio?: string | null;
  periodoFin?: string | null;
  numeroCreditos?: number | null;
  totalValorVenta?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalPagar?: number | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  saldoNeto?: number | null;
  direccionSaldo?: string | null;
  valorPagarAliado?: number | null;
  valorConsignarAliado?: number | null;
  numeroRecaudos?: number | null;
  numeroAprobacionBancaria?: string | null;
  pagadoAt?: string | null;
  createdAt?: string | null;
  registradoPorNombre?: string | null;
  estado?: string | null;
  summary?: PaymentSummary | null;
  resumen?: PaymentSummary | null;
  items?: PaymentCreditItem[] | null;
  creditos?: PaymentCreditItem[] | null;
  detalles?: PaymentCreditItem[] | null;
  recaudos?: PaymentCollectionItem[] | null;
};

export type PaymentPreview = {
  previewToken?: string | null;
  token?: string | null;
  aliado?: AllyOption | null;
  periodoInicio?: string | null;
  periodoFin?: string | null;
  summary?: PaymentSummary | null;
  resumen?: PaymentSummary | null;
  items?: PaymentCreditItem[] | null;
  creditos?: PaymentCreditItem[] | null;
  recaudos?: PaymentCollectionItem[] | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  saldoNeto?: number | null;
  direccionSaldo?: string | null;
  valorPagarAliado?: number | null;
  valorConsignarAliado?: number | null;
};

export type AllyPaymentsResponse = {
  access?: {
    adminCentral?: boolean;
    allyId?: number | null;
  };
  allies?: AllyOption[];
  settlements?: Settlement[];
  pending?: {
    items?: PaymentCreditItem[];
    summary?: PaymentSummary | null;
    recaudos?: PaymentCollectionItem[];
    totalPagarCreditos?: number | null;
    totalRecaudosAliado?: number | null;
    saldoNeto?: number | null;
    direccionSaldo?: string | null;
  } | null;
  preview?: PaymentPreview | null;
  error?: string;
  message?: string;
};
