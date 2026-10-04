import "server-only";

import { createHash } from "node:crypto";
import {
  firmaSeguroGetDocumentsByUuid,
  firmaSeguroGetProcessStatus,
  firmaSeguroGetSignaturesStatus,
  firmaSeguroSignIn,
} from "@/lib/firmaseguro";
import {
  DraftDispatchError,
  finalizeDraftDispatch,
  getDraftDispatch,
  recordVerifiedDraftDispatchReceipt,
} from "@/lib/firmaseguro-draft-dispatch-ledger";
import { isFirmaSeguroFailedStatus, isFirmaSeguroSuccessfulStatus } from "@/lib/firmaseguro-status";

type ReconciliationInput = {
  dispatchId: string;
  processUuid: string;
  // The caller must authorize and resolve this actor on the server.
  actor: { id: number; nombre: string };
};
type QueryCategory = "process_status" | "signatures" | "documents";
type RemoteRead = { category: QueryCategory; payload: unknown };
type RemoteStatus = { value: string; priority: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_TIMEOUT_MS = 10_000;
const ENVELOPES = new Set(["data", "result", "response", "value"]);
const PROCESS_KEYS = new Set(["process", "processes"]);
const PROCESS_UUID_KEYS = new Set(["processuuid", "processid"]);
const STATUS_KEYS = new Set(["status", "state", "processstatus", "statusname"]);

function fail(code: string, message: string, status = 409): never {
  throw new DraftDispatchError(`DRAFT_DISPATCH_RECONCILIATION_${code}`, message, status);
}

function normalizedKey(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeProviderStatus(value: string) {
  return value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[\s-]+/g, "_");
}

function verifiedProviderStatus(statuses: RemoteStatus[]) {
  if (!statuses.length) {
    fail("STATUS_MISSING", "El proveedor no devolvió un estado de proceso verificable. El envío conserva su estado.");
  }
  // A process state is more specific than an HTTP/business success envelope.
  const validSyntax = (value: string) => /^[A-Z0-9_]{1,80}$/.test(value);
  const failure = statuses.map((item) => item.value)
    .find((value) => validSyntax(value) && isFirmaSeguroFailedStatus(value));
  if (failure) return failure;
  const priority = Math.max(...statuses.map((item) => item.priority));
  const selected = [...new Set(statuses.filter((item) => item.priority === priority).map((item) => item.value))];
  const pending = (value: string) => /^(?:PROCESS_)?(?:CREATED|PENDING|WAITING|SENT|IN_PROGRESS|IN_PROCESS|INITIATED|STARTED)$/.test(value)
    || ["AWAITING_SIGNATURE", "PENDING_SIGNATURE"].includes(value);
  const successful = (value: string) => !/(?:^|_)(?:NOT|NO|SIN|PENDING|WAITING|AWAITING)(?:_|$)/.test(value)
    && isFirmaSeguroSuccessfulStatus(value);
  if (selected.some((value) => !validSyntax(value) || (!pending(value) && !successful(value)))) {
    fail("STATUS_UNSUPPORTED", "El estado devuelto por el proveedor no puede verificarse con seguridad. El envío conserva su estado.");
  }
  if (selected.some(pending) && selected.some(successful)) {
    fail("STATUS_CONFLICT", "El proveedor devolvió estados de proceso contradictorios. El envío conserva su estado.");
  }
  return selected[0];
}

async function boundedRead<T>(operation: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROVIDER_READ_TIMEOUT")), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readRemoteEvidence(reads: RemoteRead[]) {
  const processIds = new Set<string>();
  const reissueIds = new Set<string>();
  const folios = new Set<string>();
  const documents = new Set<string>();
  const pdfHashes = new Set<string>();
  const statuses: RemoteStatus[] = [];

  const addTag = (key: string, value: unknown) => {
    const normalized = normalizedKey(key);
    const destination = normalized === "reissue" ? reissueIds
      : normalized === "credito" || normalized === "folio" ? folios
        : normalized === "cedula" ? documents : null;
    if (!destination) return;
    if (typeof value !== "string" && typeof value !== "number") {
      fail("CONFLICT", "El proveedor devolvió etiquetas de correlación ambiguas.");
    }
    destination.add(String(value).trim());
  };
  const readTags = (value: unknown) => {
    const entries = Array.isArray(value) ? value : [value];
    for (const item of entries) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      for (const [key, tagValue] of Object.entries(record)) addTag(key, tagValue);
      const keyed = Object.fromEntries(Object.entries(record).map(([key, itemValue]) => [normalizedKey(key), itemValue]));
      const name = keyed.key ?? keyed.name ?? keyed.tag;
      if (typeof name === "string") addTag(name, keyed.value);
    }
  };
  const readPdf = (value: unknown) => {
    if (typeof value !== "string" || value.length > 32 * 1024 * 1024) return;
    const base64 = value.replace(/^data:application\/pdf;base64,/i, "").replace(/\s/g, "");
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return;
    const decoded = Buffer.from(base64, "base64");
    if (decoded.subarray(0, 5).toString() === "%PDF-") pdfHashes.add(sha256(decoded));
  };

  for (const { category, payload } of reads) {
    const seen = new Set<object>();
    let visited = 0;
    const visit = (value: unknown, depth: number, processLevel: boolean, envelope: boolean, explicitProcess: boolean) => {
      if (depth > 12 || ++visited > 5_000) {
        fail("EVIDENCE_LIMIT", "La evidencia del proveedor es demasiado compleja para verificarla con seguridad.");
      }
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1, processLevel, envelope, explicitProcess);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        const normalized = normalizedKey(key);
        if (normalized === "tags") readTags(item);
        if (PROCESS_UUID_KEYS.has(normalized)
          || (processLevel && ["uuid", "id"].includes(normalized))) {
          const internalId = normalized === "id" || normalized === "processid";
          if (typeof item === "string" && item.trim()) {
            if (!internalId || UUID.test(item.trim())) processIds.add(item.trim().toLowerCase());
          } else if (!internalId && item !== undefined && item !== null) {
            fail("UUID_MISMATCH", "El identificador del proceso no coincide con la consulta al proveedor.");
          }
        }
        if (category === "process_status" && (processLevel || envelope) && STATUS_KEYS.has(normalized)) {
          const status = typeof item === "string" ? normalizeProviderStatus(item) : "__UNVERIFIABLE_STATUS__";
          const successEnvelope = !explicitProcess && ["SUCCESS", "SUCCESSFUL", "OK"].includes(status)
            && Object.keys(value).some((field) => ENVELOPES.has(normalizedKey(field)) || PROCESS_KEYS.has(normalizedKey(field)));
          if (!successEnvelope) statuses.push({ value: status,
            priority: explicitProcess || normalized === "processstatus" ? 3 : depth > 0 ? 2 : 1 });
        }
        if (category === "documents" && /base64/i.test(key)) readPdf(item);
        visit(item, depth + 1, PROCESS_KEYS.has(normalized)
          || (processLevel && ENVELOPES.has(normalized)), envelope && ENVELOPES.has(normalized),
          PROCESS_KEYS.has(normalized) || (explicitProcess && ENVELOPES.has(normalized)));
      }
    };
    if (category === "process_status" && typeof payload === "string") {
      if (UUID.test(payload.trim())) processIds.add(payload.trim().toLowerCase());
      const status = normalizeProviderStatus(payload);
      if (status && !UUID.test(payload.trim())) statuses.push({ value: status, priority: 1 });
    }
    if (category === "documents") readPdf(payload);
    visit(payload, 0, category === "process_status", true, false);
  }
  return { processIds, reissueIds, folios, documents, pdfHashes, statuses };
}

/** A dry run: reads only local state and authenticated provider GET responses. */
export async function verifyDraftDispatchReconciliation(input: ReconciliationInput) {
  const dispatchId = String(input.dispatchId || "").trim().toLowerCase();
  const processUuid = String(input.processUuid || "").trim().toLowerCase();
  if (!UUID.test(dispatchId) || !UUID.test(processUuid)
    || !Number.isSafeInteger(input.actor?.id) || input.actor.id <= 0
    || !input.actor.nombre?.trim()) {
    fail("INVALID", "La solicitud de conciliación no es válida.", 400);
  }
  const row = await getDraftDispatch(dispatchId);
  if (!row) fail("NOT_FOUND", "No se encontró el envío que se quiere conciliar.", 404);
  if (!["DISPATCHING", "UNCERTAIN", "AWAITING_SIGNATURE"].includes(row.status)) {
    fail("STATE", "El estado del envío no admite esta conciliación.");
  }
  if (row.processUuid && row.processUuid.toLowerCase() !== processUuid) {
    fail("UUID_MISMATCH", "El envío ya tiene asociado un proceso diferente.");
  }

  const auth = await boundedRead(() => firmaSeguroSignIn()).catch(() =>
    fail("PROVIDER_UNAVAILABLE", "No se pudo autenticar la consulta al proveedor. El envío conserva su estado."));
  const categories: QueryCategory[] = ["process_status", "signatures", "documents"];
  const results = await Promise.allSettled([
    boundedRead(() => firmaSeguroGetProcessStatus(auth.token, processUuid)),
    boundedRead(() => firmaSeguroGetSignaturesStatus(auth.token, processUuid)),
    boundedRead(() => firmaSeguroGetDocumentsByUuid(processUuid, auth.token)),
  ]);
  if (results[0].status !== "fulfilled") {
    fail("PROVIDER_UNAVAILABLE", "No se pudo verificar el proceso mediante una consulta al proveedor. El envío conserva su estado.");
  }
  const reads: RemoteRead[] = results.flatMap((result, index) =>
    result.status === "fulfilled" ? [{ category: categories[index], payload: result.value }] : []);
  const remote = readRemoteEvidence(reads);
  if (remote.processIds.size > 1 || [...remote.processIds].some((id) => id !== processUuid)) {
    fail("UUID_MISMATCH", "El proveedor devolvió un identificador de proceso distinto o ambiguo.");
  }
  if (remote.reissueIds.size > 1
    || [...remote.reissueIds].some((id) => id.toLowerCase() !== dispatchId)) {
    fail("CONFLICT", "Las etiquetas del proveedor corresponden a otro envío.");
  }
  const expectedDocument = String(row.frozenCredit?.clienteDocumento || "").replace(/\D/g, "");
  if ([...remote.folios].some((folio) => folio !== row.draftFolio)
    || [...remote.documents].some((document) => !expectedDocument || document.replace(/\D/g, "") !== expectedDocument)) {
    fail("CONFLICT", "Los datos de correlación del proveedor no corresponden al expediente reservado.");
  }
  const kind = remote.reissueIds.size === 1 ? "provider_tag"
    : remote.pdfHashes.has(row.documentHash) ? "original_pdf_sha256" : null;
  if (!kind) {
    fail("EVIDENCE_INSUFFICIENT", "El proveedor no devolvió una referencia exacta del envío ni el PDF original verificable. No se modificó el envío.");
  }
  const providerStatus = verifiedProviderStatus(remote.statuses);
  // Store proof descriptors and hashes only, never provider bodies, signer data,
  // tokens, document bytes or URLs supplied by the provider.
  const evidence = {
    version: 1,
    kind,
    verifiedAt: new Date().toISOString(),
    queriedSources: categories,
    successfulSources: reads.map((read) => read.category),
    responseHashes: reads.map((read) => ({ source: read.category, sha256: sha256(JSON.stringify(read.payload) ?? "null") })),
    documentHash: row.documentHash,
    folioVerified: remote.folios.size > 0,
    documentVerified: remote.documents.size > 0,
  };
  return {
    dispatchId,
    processUuid,
    providerStatus,
    actor: { id: input.actor.id, nombre: input.actor.nombre.trim() },
    createPayload: { source: "provider_reconciliation", evidenceKind: kind },
    evidence,
  };
}

/** Never sends a signature request; materializes only a verified existing one. */
export async function reconcileDraftDispatchFromProvider(input: ReconciliationInput) {
  const verified = await verifyDraftDispatchReconciliation(input);
  await recordVerifiedDraftDispatchReceipt(verified);
  return finalizeDraftDispatch(verified.dispatchId);
}
