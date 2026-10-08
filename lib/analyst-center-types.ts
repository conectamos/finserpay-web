import type { OperationalCaseDetail, OperationalCaseSummary } from "@/lib/approval-operations-types";

/** These identifiers remain text, including their leading zeroes. */
export type AnalystCenterCase = OperationalCaseSummary & {
  creditId: number | null;
  folio: string | null;
  numeroSadmin: string | null;
};

export type AnalystCenterWelcome = {
  /** Closure of credit creation, not payment or settlement of the loan. */
  creditFinalized: boolean;
  available: false;
  reason: string;
};

export type AnalystCenterCaseDetail = OperationalCaseDetail & {
  folio: string | null;
  numeroSadmin: string | null;
};

export type AnalystCenterSearchResponse = { ok: true; items: AnalystCenterCase[] };
export type AnalystCenterDetailResponse = {
  ok: true;
  item: AnalystCenterCaseDetail;
  welcome: AnalystCenterWelcome;
};

export type AnalystCenterManagement = {
  id: string;
  at: string;
  kind: "CREDIT" | "DRAFT" | "ASSESSMENT";
  targetId: number | string;
  creditId: number | null;
  creditNumber: string | null;
  action: string;
  /** Persisted outcome/status; null when that source does not store one. */
  result: string | null;
  source: "OPERATIVO" | "FIRMA" | "SADMIN" | "APROBACION" | "NOVEDAD" |
    "CORRECCION" | "MORA" | "EXCEPCION_MORA" | "DATACREDITO_LIBERACION" |
    "IMEI_SOLICITUD" | "NOMBRE_SOLICITUD" | "GRABACION" | "REMISION_GARANTIA";
};

export type AnalystCenterManagementResponse = {
  ok: true;
  items: AnalystCenterManagement[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
