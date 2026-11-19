"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Card, DataTable, EmptyState, Input, LoadingState, PageHeader } from "@/app/_components/finser-ui";
import type { DataCreditoAllyBranchQuota } from "@/lib/datacredito/ally-branch-quota-types";
import styles from "./cupos-consultas.module.css";

const ENDPOINT = "/api/creditos/datacredito/cupos-sedes";
type SavePayload = {
  expectedDailyQueryLimit: number | null;
  branches: Array<{ branchId: number; dailyLimit: number; expectedDailyLimit: number | null }>;
  reason?: string;
};
type PendingSave = { snapshot: string; payload: SavePayload; description: string };
type Recovery = "committed" | "uncertain" | "conflict";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isLimit(value: unknown): value is number | null {
  return value === null || (isCount(value) && value <= 10000);
}
function readAlly(value: unknown): DataCreditoAllyBranchQuota | null {
  if (!isRecord(value) || !isCount(value.id) || value.id < 1 || typeof value.name !== "string" || !value.name.trim() ||
    !isLimit(value.dailyQueryLimit) || typeof value.branchQuotaEnabled !== "boolean" || !isCount(value.dailyQueriesUsed) ||
    !(value.dailyQueriesRemaining === null || isCount(value.dailyQueriesRemaining)) ||
    !(value.dailyQuotaResetsAt === null || typeof value.dailyQuotaResetsAt === "string") || !Array.isArray(value.branches)) return null;
  const ids = new Set<number>();
  for (const branch of value.branches) {
    if (!isRecord(branch) || !isCount(branch.id) || branch.id < 1 || ids.has(branch.id) ||
      typeof branch.name !== "string" || typeof branch.active !== "boolean" || !isLimit(branch.dailyQueryLimit) ||
      !isCount(branch.usedToday) || !isCount(branch.remainingToday)) return null;
    ids.add(branch.id);
  }
  return value as DataCreditoAllyBranchQuota;
}
function draftsFor(ally: DataCreditoAllyBranchQuota) {
  return Object.fromEntries(ally.branches.filter(branch => branch.active)
    .map(branch => [String(branch.id), String(branch.dailyQueryLimit ?? 0)]));
}

export default function CuposConsultasClient() {
  const [ally, setAlly] = useState<DataCreditoAllyBranchQuota | null>(null);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const sequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;

  const applyAlly = useCallback((fresh: DataCreditoAllyBranchQuota) => {
    setAlly(fresh);
    setLimits(draftsFor(fresh));
    setReason("");
    setPending(null);
  }, []);

  const reload = useCallback(async () => {
    if (busy.current) return;
    const currentSequence = ++sequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setPending(null);
    setError(null);
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store", signal: controller.signal });
      const payload: unknown = await response.json();
      if (!mounted.current || currentSequence !== sequence.current) return;
      const fresh = isRecord(payload) && payload.ok === true ? readAlly(payload.ally) : null;
      if (!response.ok || !fresh) {
        if (response.status === 401 || response.status === 403) setAlly(null);
        throw new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : "No se pudo consultar el cupo de tus sedes.");
      }
      applyAlly(fresh);
      setNotice(recoveryRef.current === "committed" ? "La distribución quedó guardada y el cupo vigente se actualizó."
        : recoveryRef.current === "uncertain" ? "Consulta completada. Revisa los cupos vigentes antes de preparar otro cambio."
          : recoveryRef.current === "conflict" ? "Se cargó la distribución vigente. Revisa los valores antes de guardar."
            : null);
      setRecovery(null);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || currentSequence !== sequence.current) return;
      setError(failure instanceof Error ? failure.message : "No se pudo consultar el cupo de tus sedes.");
    } finally {
      if (mounted.current && currentSequence === sequence.current) setLoading(false);
    }
  }, [applyAlly]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      saveController.current?.abort();
    };
  }, [reload]);

  const branches = ally?.branches.filter(branch => branch.active) ?? [];
  const parsedLimits = branches.map(branch => ({ branch, text: limits[String(branch.id)] ?? "" }));
  const validNumbers = parsedLimits.every(item => /^\d+$/.test(item.text) && Number.isSafeInteger(Number(item.text)) && Number(item.text) <= 10000);
  const allocated = validNumbers ? parsedLimits.reduce((total, item) => total + Number(item.text), 0) : null;
  const canRedistribute = Boolean(ally?.branchQuotaEnabled && ally.dailyQueryLimit !== null && branches.length);
  const issue = !validNumbers ? "Ingresa un cupo entero entre 0 y 10000 para cada sede."
    : ally?.dailyQueryLimit !== null && allocated !== null && allocated > (ally?.dailyQueryLimit ?? 0)
      ? "La suma de los cupos por sede supera el tope general del aliado." : null;
  const changed = branches.some(branch => Number(limits[String(branch.id)]) !== (branch.dailyQueryLimit ?? 0));
  const snapshot = JSON.stringify({ ally, limits, reason });
  const latest = useRef({ snapshot, pending });
  latest.current = { snapshot, pending };
  const blocked = loading || saving || Boolean(recovery);

  function updateLimit(branchId: number, value: string) {
    if (busy.current || blocked || !canRedistribute) return;
    setLimits(current => ({ ...current, [String(branchId)]: value }));
    setPending(null);
    setNotice(null);
    setError(null);
  }
  function prepareSave() {
    if (busy.current || blocked || !ally || !canRedistribute || !changed) return;
    if (issue || reason.trim().length > 240) { setError(issue || "El motivo no puede superar 240 caracteres."); return; }
    const rows = parsedLimits.map(({ branch, text }) => ({ branchId: branch.id, dailyLimit: Number(text), expectedDailyLimit: branch.dailyQueryLimit }));
    setPending({ snapshot, payload: { expectedDailyQueryLimit: ally.dailyQueryLimit, branches: rows,
      ...(reason.trim() ? { reason: reason.trim() } : {}) },
    description: `Se distribuirán ${allocated} consultas diarias entre las sedes de ${ally.name}: ${parsedLimits.map(({ branch, text }) => `${branch.name}: ${Number(text)}`).join("; ")}. El tope general seguirá en ${ally.dailyQueryLimit} consultas. Las ${ally.dailyQueriesUsed} consultas usadas hoy se conservan.` });
  }

  async function confirmSave() {
    const prepared = latest.current.pending;
    if (busy.current || loading || recoveryRef.current || !prepared) return;
    if (prepared.snapshot !== latest.current.snapshot) {
      setPending(null); setError("Los valores cambiaron. Revisa nuevamente la distribución antes de confirmar."); return;
    }
    busy.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    saveController.current = controller;
    try {
      const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.payload), signal: controller.signal });
      const payload: unknown = await response.json();
      if (!mounted.current) return;
      setPending(null);
      if (isRecord(payload) && payload.ok === true && payload.operationCommitted === true) {
        setRecovery("committed");
        setNotice("La distribución quedó guardada. Consulta el cupo vigente para actualizar la pantalla antes de otro cambio.");
        return;
      }
      const fresh = isRecord(payload) && payload.ok === true ? readAlly(payload.ally) : null;
      if (response.ok && fresh) {
        applyAlly(fresh);
        setNotice("La distribución de consultas quedó guardada. El tope general y el consumo de hoy se conservan.");
        return;
      }
      if (response.status === 401 || response.status === 403) setAlly(null);
      const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : "No se pudo confirmar el resultado del cambio.";
      setError(message);
      if (response.status === 409) setRecovery("conflict");
      else if (response.status >= 500 || response.ok) setRecovery("uncertain");
    } catch {
      if (!mounted.current) return;
      setPending(null);
      setRecovery("uncertain");
      setError("No se pudo confirmar el resultado. Consulta los cupos vigentes antes de intentar otro cambio.");
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <main className={styles.page}>
    <PageHeader eyebrow="Administración del aliado" title="Cupos de consultas"
      description="Redistribuye las consultas diarias entre tus sedes. El tope general lo define FINSERPAY."
      actions={<Button variant="secondary" onClick={() => void reload()} disabled={loading || saving}>
        <RefreshCw size={18} aria-hidden="true" />{recovery ? "Consultar cupos vigentes" : "Actualizar"}
      </Button>} />
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {loading ? <LoadingState label="Consultando los cupos de tus sedes…" /> : null}
    {!ally && !loading ? <EmptyState title="Cupos no disponibles" description="Actualiza la consulta para revisar los cupos autorizados de tu aliado." /> : null}
    {ally ? <Card className={styles.editor} aria-busy={loading || saving}>
      <div className={styles.heading}><div><span>Cupo diario por sede</span><h2>{ally.name}</h2></div></div>
      <dl className={styles.totals}>
        <div><dt>Tope general del aliado</dt><dd>{ally.dailyQueryLimit === null ? "Sin límite" : ally.dailyQueryLimit}</dd></div>
        <div><dt>Usadas hoy</dt><dd>{ally.dailyQueriesUsed}</dd></div>
        <div><dt>Disponibles del total hoy</dt><dd>{ally.dailyQueriesRemaining === null ? "Sin límite" : ally.dailyQueriesRemaining}</dd></div>
        <div><dt>Repartidas entre sedes</dt><dd>{ally.branchQuotaEnabled ? allocated ?? "—" : "Cupo compartido"}</dd></div>
        <div><dt>Sin asignar</dt><dd>{ally.branchQuotaEnabled && allocated !== null && ally.dailyQueryLimit !== null ? Math.max(0, ally.dailyQueryLimit - allocated) : "—"}</dd></div>
      </dl>
      {!ally.branchQuotaEnabled || ally.dailyQueryLimit === null ? <p className={styles.warning} role="status">
        FINSERPAY debe habilitar la distribución por sedes y definir un tope general antes de redistribuir las consultas.
      </p> : null}
      {branches.length ? <>
        <DataTable><table className={styles.table}>
          <caption>Cupos de las sedes de {ally.name}</caption>
          <thead><tr><th scope="col">Sede</th><th scope="col">Usadas hoy</th><th scope="col">Disponibles hoy</th><th scope="col">Cupo diario</th></tr></thead>
          <tbody>{branches.map(branch => <tr key={branch.id}>
            <th scope="row">{branch.name}</th><td>{branch.usedToday}</td><td>{branch.remainingToday}</td>
            <td><Input id={`branch-quota-${branch.id}`} aria-label={`Cupo diario de ${branch.name}`} type="number" inputMode="numeric"
              min={0} max={10000} step={1} value={limits[String(branch.id)] ?? ""} disabled={blocked || !canRedistribute}
              onChange={event => updateLimit(branch.id, event.target.value)} /></td>
          </tr>)}</tbody>
        </table></DataTable>
        <p className={styles.help}>Las consultas usadas hoy se mantienen. La disponibilidad de cada sede también respeta el saldo general del aliado.</p>
        {canRedistribute ? <>
          <label className={styles.reason} htmlFor="quota-redistribution-reason">Motivo del cambio (opcional)
            <Input id="quota-redistribution-reason" value={reason} maxLength={240} disabled={blocked}
              onChange={event => { if (busy.current || blocked) return; setReason(event.target.value); setPending(null); }} />
          </label>
          {issue ? <p className={styles.error} role="alert">{issue}</p> : null}
          <div className={styles.saveBar}><p>{recovery ? "Consulta los cupos vigentes para continuar." : changed ? "Distribución pendiente de guardar." : "La distribución coincide con lo guardado."}</p>
            <Button onClick={prepareSave} disabled={blocked || !changed || Boolean(issue)}>Guardar distribución</Button>
          </div>
        </> : null}
      </> : <EmptyState title="Sin sedes activas" description="No hay sedes activas para distribuir las consultas." />}
    </Card> : null}
    <ConfirmDialog open={Boolean(pending)} title="Confirmar distribución de consultas"
      description={pending?.description ?? ""} confirmLabel="Aplicar distribución" busy={saving}
      onCancel={() => { if (!busy.current) setPending(null); }} onConfirm={() => void confirmSave()} />
  </main>;
}
