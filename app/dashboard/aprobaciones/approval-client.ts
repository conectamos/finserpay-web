export type ApprovalStatus = "PENDING" | "APPROVED" | "NOT_REQUIRED";

export type ApprovalListItem = {
  id: number;
  folio: string;
  clienteDocumento: string | null;
  clienteNombre: string;
  aliadoNombre: string;
  fechaCredito: string | null;
  status: ApprovalStatus;
  required: boolean;
};

export type ApprovalDetail = Omit<ApprovalListItem, "status" | "required"> & {
  score: number | null;
  scoreLabel?: string | null;
  initialPaymentPercentage: number | null;
  cuotaInicial: number;
  creditoAutorizado: number;
  approvedLimit: number | null;
  valorVenta: number;
  review: {
    required: boolean;
    status: ApprovalStatus;
    revision: number;
    reviewHash: string;
    approvedAt: string | null;
    approvedByName: string | null;
  };
  canApprove: boolean;
  blockingReasons: string[];
  evidence: Array<{ key: string; label: string; available: boolean; href: string }>;
  document: { available: boolean; href: string; fileName: string | null };
};

export class ApprovalRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApprovalRequestError";
    this.status = status;
  }
}

async function readResult<T>(response: Response, fallback: string): Promise<T> {
  let result: T & { ok?: boolean; error?: string };
  try {
    result = await response.json();
  } catch {
    throw new ApprovalRequestError(fallback, response.status);
  }
  if (!response.ok || !result || result.ok === false) {
    throw new ApprovalRequestError(result?.error || fallback, response.status);
  }
  return result;
}

export async function searchApprovalCredits(documento: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ documento });
  const response = await fetch(`/api/aprobaciones?${query}`, { cache: "no-store", signal });
  const result = await readResult<{ items: ApprovalListItem[] }>(response, "No fue posible buscar los créditos.");
  if (!Array.isArray(result.items)) throw new ApprovalRequestError("La búsqueda no devolvió una respuesta válida.", response.status);
  return result.items;
}

export async function readApprovalCredit(id: number, signal?: AbortSignal) {
  const response = await fetch(`/api/aprobaciones/${id}`, { cache: "no-store", signal });
  const result = await readResult<{ item: ApprovalDetail }>(response, "No fue posible cargar el expediente.");
  if (!result.item || result.item.id !== id) throw new ApprovalRequestError("El expediente recibido no corresponde al crédito seleccionado.", response.status);
  return result.item;
}

export async function approveCreditReview(id: number, revision: number, reviewHash: string) {
  const response = await fetch(`/api/aprobaciones/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, reviewHash }),
  });
  const result = await readResult<{ ok?: boolean }>(response, "No fue posible confirmar la aprobación. Actualiza el expediente antes de intentarlo de nuevo.");
  if (result.ok !== true) throw new ApprovalRequestError("No se recibió confirmación de la aprobación. Actualiza el expediente antes de intentarlo de nuevo.", response.status);
  return result;
}
