export type SessionUser = {
  id: number;
  nombre: string;
  usuario: string;
  sedeId: number;
  sedeNombre: string;
  aliadoAccesoCodigo?: string | null;
  rolId: number;
  rolNombre: string;
};

export type SedeItem = {
  id: number;
  nombre: string;
  codigo?: string | null;
  aliadoId?: number | null;
  aliado?: {
    id: number;
    nombre: string;
    codigo: string | null;
  } | null;
};

export type AliadoItem = {
  id: number;
  nombre: string;
  codigo: string | null;
};

export type PaymentReportItem = {
  id: number;
  valor: number;
  metodoPago: string;
  observacion: string | null;
  estado: string;
  anuladoAt: string | null;
  anulacionMotivo: string | null;
  fechaAbono: string;
  credito: {
    id: number;
    folio: string;
    numeroCreditoVisible?: string | null;
    numeroSadmin?: string | null;
    clienteNombre: string;
    clienteDocumento: string | null;
    sede?: {
      id: number;
      nombre: string;
      codigo?: string | null;
      aliadoId?: number | null;
      aliado?: {
        id: number;
        nombre: string;
        codigo: string | null;
      } | null;
    };
  };
  usuario: {
    id: number;
    nombre: string;
    usuario: string;
  };
  vendedor: {
    id: number;
    nombre: string;
    usuario: string;
  };
  sede: {
    id: number;
    nombre: string;
    codigo?: string | null;
    aliadoId?: number | null;
    aliado?: {
      id: number;
      nombre: string;
      codigo: string | null;
    } | null;
  };
};

export type PaymentByDay = {
  fecha: string;
  total: number;
  cantidad: number;
};

export type PaymentReportResponse = {
  ok: boolean;
  summary: {
    totalAbonos: number;
    totalRecaudadoPeriodo: number;
    totalPendientePorCobrar: number;
    totalRecaudadoGeneral: number;
    totalCreditos: number;
    creditosAlDia: number;
  };
  byDay: PaymentByDay[];
  items: PaymentReportItem[];
};


export function paymentReportMoney(value: number) { return '$ '+Number(value||0).toLocaleString('es-CO'); }
function normalizeText(value: string|null|undefined){return String(value||'').trim().toUpperCase();}
export function paymentReportCollector(item: PaymentReportItem){
 const code=normalizeText(item.sede?.codigo).replace(/[\s-]+/g,'_');
 const name=normalizeText(item.sede?.nombre);
 if(code==='RECAUDO_DIGITAL'||name==='RECAUDO DIGITAL FINSER PAY'||(name.includes('RECAUDO')&&name.includes('DIGITAL')))return 'DIGITAL';
 return item.vendedor?.nombre||item.usuario?.nombre||item.sede?.nombre||'-';
}
export function paymentReportDate(value: string|null,withTime=false){
 if(!value)return '-';
 const ymd=value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 const date=ymd?new Date(value+'T12:00:00Z'):new Date(value);
 if(Number.isNaN(date.getTime()))return value;
 return new Intl.DateTimeFormat('es-CO',withTime?{dateStyle:'short',timeStyle:'short',timeZone:'America/Bogota'}:{day:'2-digit',month:'short',year:'numeric',timeZone:'America/Bogota'}).format(date).replace(/ de /g,' ');
}
