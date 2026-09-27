"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Card, EmptyState, Input, LoadingState, StatusPill } from "@/app/_components/finser-ui";

type Authorization = {
  id: string;
  documento: string;
  active: boolean;
  version: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
};

type Lookup = {
  documento: string;
  activeCredits: number;
  activeFolios: string[];
  canCreate: boolean;
  authorization: Authorization | null;
};

type Mutation = {
  documentNumber: string;
  action: "AUTHORIZE" | "REVOKE";
  reason: string;
  mutationId: string;
  expectedVersion: number;
};

const ENDPOINT = "/api/creditos/autorizaciones-segundo-credito";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLookup(payload: unknown, documentNumber: string): Lookup {
  if (!isRecord(payload) || payload.ok !== true || payload.documento !== documentNumber ||
      !Number.isInteger(payload.activeCredits) || Number(payload.activeCredits) < 0 ||
      typeof payload.canCreate !== "boolean" || !Array.isArray(payload.activeFolios) ||
      !payload.activeFolios.every((folio) => typeof folio === "string")) {
    throw new Error("No se pudo confirmar el estado de la cédula. Consulta de nuevo.");
  }
  const authorization = payload.authorization;
  if (authorization !== null && (!isRecord(authorization) ||
      typeof authorization.id !== "string" || authorization.documento !== documentNumber ||
      typeof authorization.active !== "boolean" || !Number.isInteger(authorization.version) ||
      Number(authorization.version) < 1 || typeof authorization.reason !== "string" ||
      typeof authorization.createdAt !== "string" || typeof authorization.updatedAt !== "string")) {
    throw new Error("No se pudo confirmar la autorización. Consulta de nuevo.");
  }
  return {
    documento: documentNumber,
    activeCredits: Number(payload.activeCredits),
    activeFolios: payload.activeFolios as string[],
    canCreate: payload.canCreate,
    authorization: authorization as Authorization | null,
  };
}

function responseError(payload: unknown, fallback: string) {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (typeof payload.message === "string" && payload.message) return payload.message;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sin fecha" : new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota",
  }).format(date);
}

export default function SecondCreditAuthorizationConsole() {
  const [documentNumber, setDocumentNumber] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<Mutation | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const busy = loading || saving;

  useEffect(() => () => searchAbort.current?.abort(), []);

  function updateDocument(value: string) {
    setDocumentNumber(value.replace(/\D/g, "").slice(0, 13));
    setLookup(null);
    setReason("");
    setPendingMutation(null);
    setError(null);
    setNotice(null);
  }

  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy) return;
    const normalizedDocumentNumber = documentNumber.replace(/^0+/, "");
    if (!/^\d{3,13}$/.test(normalizedDocumentNumber)) {
      setError("Ingresa una cédula de 3 a 13 dígitos para realizar una búsqueda exacta.");
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setLoading(true);
    setLookup(null);
    setError(null);
    setNotice(null);
    setPendingMutation(null);
    setReason("");
    try {
      const response = await fetch(`${ENDPOINT}/buscar`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        cache: "no-store", body: JSON.stringify({ documentNumber: normalizedDocumentNumber }), signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(payload, "No se pudo consultar la cédula. Reintenta."));
      if (!controller.signal.aborted) setLookup(parseLookup(payload, normalizedDocumentNumber));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudo consultar la cédula. Reintenta.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function prepareMutation(action: Mutation["action"]) {
    if (!lookup || busy || (action === "AUTHORIZE" && lookup.activeCredits >= 2)) return;
    const cleanReason = reason.trim();
    if (cleanReason.length < 5 || cleanReason.length > 500) {
      setError("Escribe un motivo de 5 a 500 caracteres para registrar la decisión.");
      return;
    }
    setError(null);
    setNotice(null);
    setPendingMutation({
      documentNumber: lookup.documento, action, reason: cleanReason,
      mutationId: crypto.randomUUID(), expectedVersion: lookup.authorization?.version ?? 0,
    });
    setConfirmOpen(true);
  }

  async function executeMutation() {
    if (!pendingMutation || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        cache: "no-store", body: JSON.stringify(pendingMutation),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          setLookup(null);
          setPendingMutation(null);
        }
        throw new Error(responseError(payload, "No se pudo guardar la decisión. Reintenta."));
      }
      const next = parseLookup(payload, pendingMutation.documentNumber);
      if (next.authorization?.active !== (pendingMutation.action === "AUTHORIZE")) {
        throw new Error("El servidor no confirmó el cambio de autorización. Consulta de nuevo antes de continuar.");
      }
      setLookup(next);
      setReason("");
      setNotice(pendingMutation.action === "AUTHORIZE"
        ? "Autorización registrada. Esta cédula puede tener hasta dos créditos vigentes; se mantienen las evaluaciones y aprobaciones."
        : "Autorización revocada. Se aplica nuevamente el bloqueo cuando hay un crédito vigente.");
      setPendingMutation(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la decisión. Reintenta.");
    } finally {
      setConfirmOpen(false);
      setSaving(false);
      savingRef.current = false;
    }
  }

  const authorization = lookup?.authorization;
  const authorizing = pendingMutation?.action === "AUTHORIZE";
  const reasonValid = reason.trim().length >= 5 && reason.trim().length <= 500;

  return (
    <section className="space-y-5" aria-label="Autorizaciones para segundo crédito">
      <div>
        <h3 className="flex items-center gap-2 text-xl font-black">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" /> Segundo crédito
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fp-muted)]">
          Con saldo pendiente no puede sacar otro crédito. Una autorización activa permite hasta dos
          créditos vigentes. Se mantienen las evaluaciones y aprobaciones existentes.
        </p>
      </div>

      <Card className="p-5 sm:p-6">
        <form onSubmit={(event) => void search(event)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="second-credit-document" className="mb-2 block text-sm font-bold">Buscar cédula exacta</label>
            <Input id="second-credit-document" inputMode="numeric" autoComplete="off" maxLength={13}
              value={documentNumber} onChange={(event) => updateDocument(event.target.value)} disabled={busy}
              placeholder="Número de cédula" aria-describedby="second-credit-search-help" />
          </div>
          <Button type="submit" variant="secondary" disabled={busy || !documentNumber}>
            <Search className="h-4 w-4" aria-hidden="true" /> {loading ? "Consultando..." : "Consultar cédula"}
          </Button>
        </form>
        <p id="second-credit-search-help" className="mt-3 text-sm text-[var(--fp-muted)]">
          La consulta y la autorización corresponden únicamente a la cédula ingresada.
        </p>
      </Card>

      {notice ? <div role="status" aria-live="polite" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-lime)] bg-[var(--fp-lime-soft)] px-4 py-3 text-sm">{notice}</div> : null}
      {error ? <div role="alert" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm text-[var(--fp-danger)]">
        <p>{error}</p>
        {!busy && pendingMutation ? <Button variant="secondary" className="mt-3" onClick={() => setConfirmOpen(true)}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reintentar {pendingMutation.action === "AUTHORIZE" ? "autorización" : "revocación"}
        </Button> : !busy && !lookup ? <Button variant="secondary" className="mt-3" disabled={!documentNumber} onClick={() => void search()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reintentar consulta
        </Button> : null}
      </div> : null}

      {loading ? <LoadingState label="Consultando créditos vigentes y autorización..." /> : lookup ? (
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-lg font-black">Cédula terminada en {lookup.documento.slice(-4)}</h4>
              <p className="mt-1 text-sm text-[var(--fp-muted)]">{lookup.activeCredits} crédito(s) vigente(s) con saldo pendiente</p>
            </div>
            <StatusPill tone={authorization?.active ? "positive" : "neutral"}>
              {authorization?.active ? "Autorización activa · máximo 2" : "Sin autorización activa"}
            </StatusPill>
          </div>
          {lookup.activeFolios.length ? <p className="mt-3 break-words text-sm text-[var(--fp-muted)]">Créditos vigentes: {lookup.activeFolios.join(", ")}</p> : null}
          <p className="mt-4 text-sm font-semibold">
            {lookup.activeCredits >= 2 ? "Ya tiene dos o más créditos vigentes. No puede crear otro aunque la autorización esté activa."
              : lookup.canCreate ? "Puede solicitar un nuevo crédito, sujeto a las evaluaciones y aprobaciones vigentes."
                : "El crédito vigente bloquea una nueva solicitud. El administrador puede autorizar el segundo crédito."}
          </p>
          {authorization ? <div className="mt-4 border-t border-[var(--fp-border)] pt-4 text-sm text-[var(--fp-muted)]">
            <p className="whitespace-pre-wrap break-words"><strong>Último motivo:</strong> {authorization.reason}</p>
            <p className="mt-2">Última decisión: {formatDate(authorization.updatedAt)}{authorization.updatedByName ? ` · ${authorization.updatedByName}` : ""}</p>
          </div> : null}
          <div className="mt-5">
            <label htmlFor="second-credit-reason" className="mb-2 block text-sm font-bold">Motivo de la decisión</label>
            <textarea id="second-credit-reason" className="fp-ui-input min-h-24 w-full" rows={3} maxLength={500}
              value={reason} disabled={busy} aria-describedby="second-credit-reason-help"
              onChange={(event) => { setReason(event.target.value); setPendingMutation(null); setError(null); setNotice(null); }}
              placeholder="Describe por qué autorizas o revocas el segundo crédito" />
            <p id="second-credit-reason-help" className="mt-2 text-sm text-[var(--fp-muted)]">
              Escribe entre 5 y 500 caracteres. El motivo, el administrador y la fecha quedan registrados.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant={authorization?.active ? "danger" : "primary"}
              disabled={busy || !reasonValid || Boolean(pendingMutation) || (!authorization?.active && lookup.activeCredits >= 2)}
              onClick={() => prepareMutation(authorization?.active ? "REVOKE" : "AUTHORIZE")}>
              {saving ? "Guardando..." : authorization?.active ? "Revocar autorización" : "Autorizar segundo crédito"}
            </Button>
          </div>
        </Card>
      ) : !error ? <EmptyState title="Consulta una cédula para autorizar un segundo crédito"
        description="Solo el administrador central puede registrar o revocar esta autorización. La regla general sigue bloqueando un nuevo crédito cuando hay saldo pendiente." /> : null}

      <ConfirmDialog open={confirmOpen && Boolean(pendingMutation)}
        title={authorizing ? "Autorizar segundo crédito" : "Revocar autorización"}
        description={authorizing
          ? `La cédula terminada en ${pendingMutation?.documentNumber.slice(-4)} podrá tener hasta dos créditos vigentes mientras esta autorización esté activa. Se mantienen las evaluaciones y aprobaciones. Motivo: ${pendingMutation?.reason}`
          : `Se revocará la autorización de la cédula terminada en ${pendingMutation?.documentNumber.slice(-4)}. Los créditos existentes se conservan y una nueva solicitud queda bloqueada si hay saldo pendiente. Motivo: ${pendingMutation?.reason}`}
        confirmLabel={authorizing ? "Confirmar autorización" : "Confirmar revocación"}
        danger={!authorizing} busy={saving}
        onCancel={() => { if (!savingRef.current) { setConfirmOpen(false); setPendingMutation(null); } }}
        onConfirm={() => void executeMutation()} />
    </section>
  );
}