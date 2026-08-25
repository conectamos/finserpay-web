export const SOLICITUD_EXPIRATION_DAYS = 15;

export const SOLICITUD_STATES = [
  "CONSULTA_PENDIENTE",
  "APROBADA",
  "RECHAZADA",
  "VALIDACION_FACIAL",
  "CONTRATOS",
  "LISTA_PARA_ENTREGA",
  "ENTREGADA",
  "CANCELADA",
  "ERROR_TECNICO",
] as const;

export type SolicitudState = (typeof SOLICITUD_STATES)[number];

export const SOLICITUD_STATE_LABELS: Record<SolicitudState, string> = {
  CONSULTA_PENDIENTE: "Consulta pendiente",
  APROBADA: "Aprobada",
  RECHAZADA: "Rechazada",
  VALIDACION_FACIAL: "Validación facial",
  CONTRATOS: "Contratos",
  LISTA_PARA_ENTREGA: "Lista para entrega",
  ENTREGADA: "Entregada",
  CANCELADA: "Cancelada",
  ERROR_TECNICO: "Error técnico",
};

export type SolicitudViewer = {
  kind: "CENTRAL_ADMIN" | "ALLY_ADMIN" | "SUPERVISOR" | "SELLER";
  userId: number;
  aliadoId: number | null;
  sedeId: number | null;
  vendedorId: number | null;
};

export type SolicitudOwnership = {
  aliadoId: number | null;
  sedeId: number | null;
  vendedorId: number | null;
  usuarioId?: number | null;
};

export type SolicitudSignals = {
  source: "DRAFT" | "CREDIT";
  draftState?: string | null;
  closedReason?: string | null;
  currentStep?: number | null;
  dataCreditoStatus?: string | null;
  dataCreditoErrorCode?: string | null;
  veriffStatus?: string | null;
  firmaStatus?: string | null;
  firmaLastError?: string | null;
  creditState?: string | null;
};

export type SolicitudAction = "VER_DETALLE" | "RETOMAR" | "DESISTIR" | "VER_CREDITO";

export type SolicitudFilters = {
  q: string;
  desde: string;
  hasta: string;
  aliadoId: number | null;
  sedeId: number | null;
  asesorId: number | null;
  plataforma: string;
  estado: SolicitudState | "";
  page: number;
  pageSize: number;
  id: string;
};

type FilterSource = URLSearchParams | Record<string, unknown>;

function readFilter(source: FilterSource, key: string) {
  const value = source instanceof URLSearchParams ? source.get(key) : source[key];
  return Array.isArray(value) ? value[0] : value;
}

function compactText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDateFilter(value: unknown) {
  const text = compactText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text
    ? ""
    : text;
}

export function normalizeSolicitudFilters(source: FilterSource): SolicitudFilters {
  const requestedState = compactText(readFilter(source, "estado"), 40).toUpperCase();
  const requestedPage = positiveInteger(readFilter(source, "page")) ?? 1;
  const requestedPageSize = positiveInteger(readFilter(source, "pageSize")) ?? 25;

  return {
    q: compactText(readFilter(source, "q"), 120),
    desde: validDateFilter(readFilter(source, "desde")),
    hasta: validDateFilter(readFilter(source, "hasta")),
    aliadoId: positiveInteger(readFilter(source, "aliadoId")),
    sedeId: positiveInteger(readFilter(source, "sedeId")),
    asesorId: positiveInteger(readFilter(source, "asesorId")),
    plataforma: compactText(readFilter(source, "plataforma"), 60).toUpperCase(),
    estado: SOLICITUD_STATES.includes(requestedState as SolicitudState)
      ? (requestedState as SolicitudState)
      : "",
    page: Math.min(requestedPage, 10_000),
    pageSize: Math.min(requestedPageSize, 100),
    id: compactText(readFilter(source, "id"), 80),
  };
}

export function canViewSolicitud(
  viewer: SolicitudViewer,
  ownership: SolicitudOwnership
) {
  if (viewer.kind === "CENTRAL_ADMIN") return true;
  if (!viewer.aliadoId || viewer.aliadoId !== ownership.aliadoId) return false;
  if (viewer.kind === "ALLY_ADMIN") return true;
  if (!viewer.sedeId || viewer.sedeId !== ownership.sedeId) return false;
  if (viewer.kind === "SUPERVISOR") return true;
  return Boolean(
    viewer.vendedorId && viewer.vendedorId === ownership.vendedorId
  );
}

export function canSeeSensitiveSolicitudData(viewer: SolicitudViewer) {
  return viewer.kind === "CENTRAL_ADMIN" || viewer.kind === "ALLY_ADMIN";
}

export function isSolicitudExpired(
  createdAt: Date | string | number,
  now: Date | string | number = new Date()
) {
  const createdTime = new Date(createdAt).getTime();
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(createdTime) || !Number.isFinite(nowTime)) return false;
  return nowTime >= createdTime + SOLICITUD_EXPIRATION_DAYS * 24 * 60 * 60 * 1_000;
}

function normalized(value: unknown) {
  return compactText(value, 80).toUpperCase();
}

export function resolveSolicitudStage(signals: SolicitudSignals): SolicitudState {
  const creditState = normalized(signals.creditState);
  const draftState = normalized(signals.draftState);
  const closedReason = normalized(signals.closedReason);
  const dataCreditoStatus = normalized(signals.dataCreditoStatus);
  const dataCreditoError = normalized(signals.dataCreditoErrorCode);
  const veriffStatus = normalized(signals.veriffStatus);
  const firmaStatus = normalized(signals.firmaStatus);

  if (signals.source === "CREDIT") {
    return ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(creditState)
      ? "CANCELADA"
      : "APROBADA";
  }

  if (
    draftState === "CERRADO" &&
    ["DESISTIDA", "DESISTIDO", "EXPIRADA_15_DIAS", "EXPIRADA"].includes(closedReason)
  ) {
    return "CANCELADA";
  }

  if (dataCreditoStatus === "RECHAZADO" || closedReason === "RECHAZADA") {
    return "RECHAZADA";
  }

  if (
    (dataCreditoStatus === "NO_EVALUADO" && Boolean(dataCreditoError)) ||
    veriffStatus === "ERROR" ||
    Boolean(compactText(signals.firmaLastError, 200))
  ) {
    return "ERROR_TECNICO";
  }

  if (!dataCreditoStatus || dataCreditoStatus === "PENDING") {
    return "CONSULTA_PENDIENTE";
  }

  if (dataCreditoStatus !== "APROBADO") {
    return "CONSULTA_PENDIENTE";
  }

  if (!veriffStatus) return "APROBADA";

  if (veriffStatus !== "APPROVED") {
    return "VALIDACION_FACIAL";
  }

  if (
    ["SIGNED", "COMPLETED", "COMPLETADO", "FIRMADO"].includes(firmaStatus) ||
    Number(signals.currentStep || 0) >= 5
  ) {
    return "LISTA_PARA_ENTREGA";
  }

  return "CONTRATOS";
}

export function resolveSolicitudDeliveryStage(input: {
  creditState?: string | null;
  deliverableReady?: boolean | null;
  deliveredAt?: Date | string | null;
  hasDeliveryEvidence?: boolean | null;
}): "LISTA_PARA_ENTREGA" | "ENTREGADA" | null {
  const creditState = normalized(input.creditState);
  if (
    input.deliveredAt ||
    input.hasDeliveryEvidence ||
    ["ENTREGADO", "ENTREGADA"].includes(creditState)
  ) {
    return "ENTREGADA";
  }
  if (input.deliverableReady || creditState === "ENTREGABLE") {
    return "LISTA_PARA_ENTREGA";
  }
  return null;
}

export function getSolicitudActions(input: {
  viewer: SolicitudViewer;
  ownership: SolicitudOwnership;
  source: "DRAFT" | "CREDIT";
  state: SolicitudState;
  draftState?: string | null;
}): SolicitudAction[] {
  if (!canViewSolicitud(input.viewer, input.ownership)) return [];

  const actions: SolicitudAction[] = ["VER_DETALLE"];
  if (input.source === "CREDIT") {
    actions.push("VER_CREDITO");
    return actions;
  }

  const isOpen = normalized(input.draftState) === "ABIERTO";
  const isOwner = Boolean(
    input.viewer.kind === "SELLER" &&
      input.viewer.vendedorId &&
      input.viewer.vendedorId === input.ownership.vendedorId
  );
  if (isOpen && isOwner && !["RECHAZADA", "CANCELADA"].includes(input.state)) {
    actions.push("RETOMAR", "DESISTIR");
  }
  return actions;
}

export function maskDocument(value?: string | null) {
  const text = compactText(value, 80);
  if (text.length <= 4) return text;
  return `${"•".repeat(Math.max(2, text.length - 4))}${text.slice(-4)}`;
}

export function maskImei(value?: string | null) {
  const text = compactText(value, 80);
  if (text.length <= 4) return text;
  return `${text.slice(0, 3)}${"•".repeat(Math.max(4, text.length - 7))}${text.slice(-4)}`;
}
