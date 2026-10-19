"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";

type Batch = {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  total: number;
  pending: number;
  accepted: number;
  failed: number;
  unknown: number;
  skipped: number;
  dateKey?: string;
  excludedActiveMoraProtection?: number;
};
type Result = { configured: boolean; batch: Batch | null };
const campaigns = {
  cuotavencida: {
    endpoint: "/api/dashboard/cartera/cuotavencida",
    name: "Cuotavencida",
    label: "Enviar Cuotavencida por WhatsApp",
    scope: "Clientes con 1 día de mora o más · todos los aliados y productos",
    empty: "No hay clientes elegibles con mora de un día o más.",
  },
  bloqueo: {
    endpoint: "/api/dashboard/cartera/bloqueo",
    name: "BLOQUEO",
    label: "Enviar BLOQUEO por WhatsApp",
    scope: "Clientes en mora sin prórroga activa · todos los aliados y productos",
    empty: "No hay clientes en mora elegibles sin prórroga activa.",
  },
} as const;
type Campaign = keyof typeof campaigns;
const count = new Intl.NumberFormat("es-CO");
const active = (batch: Batch | null | undefined) => batch?.status === "QUEUED" || batch?.status === "RUNNING";

function parseResult(value: unknown): Result | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.ok !== true || typeof body.configured !== "boolean") return null;
  if (body.batch === null) return { configured: body.configured, batch: null };
  if (!body.batch || typeof body.batch !== "object" || Array.isArray(body.batch)) return null;
  const batch = body.batch as Record<string, unknown>;
  const stats = batch.stats && typeof batch.stats === "object" && !Array.isArray(batch.stats)
    ? batch.stats as Record<string, unknown> : null;
  if (typeof batch.id !== "string" || !batch.id || batch.id.length > 128
    || typeof batch.status !== "string" || !["QUEUED", "RUNNING", "COMPLETED"].includes(batch.status)) return null;
  const fields = ["total", "pending", "accepted", "failed", "unknown", "skipped"] as const;
  if (fields.some(key => !Number.isSafeInteger(batch[key]) || Number(batch[key]) < 0)) return null;
  return { configured: body.configured, batch: {
    id: batch.id, status: batch.status as Batch["status"],
    total: Number(batch.total), pending: Number(batch.pending), accepted: Number(batch.accepted),
    failed: Number(batch.failed), unknown: Number(batch.unknown), skipped: Number(batch.skipped),
    ...(typeof batch.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(batch.dateKey) ? { dateKey: batch.dateKey } : {}),
    ...(Number.isSafeInteger(stats?.excludedActiveMoraProtection) && Number(stats?.excludedActiveMoraProtection) >= 0
      ? { excludedActiveMoraProtection: Number(stats?.excludedActiveMoraProtection) } : {}),
  } };
}

export default function CuotavencidaWhatsappButton({ campaign = "cuotavencida" }: { campaign?: Campaign } = {}) {
  // A different campaign gets fresh request, polling and result state.
  return <CampaignWhatsappButton key={campaign} campaign={campaign} />;
}

function CampaignWhatsappButton({ campaign }: { campaign: Campaign }) {
  const config = campaigns[campaign];
  const endpoint = config.endpoint;
  const [result, setResult] = useState<Result | null>(null);
  const [reading, setReading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const scopeId = useId();
  const latest = useRef<Result | null>(null);
  const requestId = useRef<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const uncertain = useRef(false);
  const postController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; postController.current?.abort(); };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let polling = active(latest.current?.batch);
    const live = () => !disposed && generation.current === current;
    async function read() {
      if (!live()) return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const response = await fetch(endpoint, { method: "GET", cache: "no-store", signal: controller.signal });
        const data = parseResult(await response.json());
        if (!response.ok || !data) throw new Error("UNCONFIRMED_BATCH");
        if (!live()) return;
        latest.current = data;
        setResult(data);
        polling = active(data.batch);
        if (!uncertain.current) setError("");
      } catch {
        if (live()) setError(uncertain.current
          ? "No se pudo confirmar la solicitud. Al reintentar se usará el mismo lote."
          : `No se pudo consultar el estado de ${config.name}. Intenta actualizar.`);
      } finally {
        clearTimeout(timeout);
        if (live()) {
          setReading(false);
          if (polling) timer = setTimeout(() => { void read(); }, 3_000);
        }
      }
    }
    void read();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
  }, [reload, endpoint, config.name]);

  async function send() {
    if (busy.current || reading || latest.current?.configured !== true || active(latest.current.batch)) return;
    busy.current = true;
    generation.current++;
    setSending(true);
    setError("");
    const controller = new AbortController();
    postController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      requestId.current ??= crypto.randomUUID();
      const response = await fetch(endpoint, {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current }), signal: controller.signal,
      });
      const data = parseResult(await response.json());
      if (!response.ok || !data?.batch) throw new Error("UNCONFIRMED_BATCH");
      if (!mounted.current) return;
      latest.current = data;
      setResult(data);
      requestId.current = null;
      uncertain.current = false;
    } catch {
      if (mounted.current) {
        uncertain.current = true;
        setError("No se pudo confirmar la solicitud. Al reintentar se usará el mismo lote.");
      }
    } finally {
      clearTimeout(timeout);
      postController.current = null;
      busy.current = false;
      if (mounted.current) {
        setSending(false);
        setReading(true);
        // Reconciliation and polling always use GET; only the user's click sends POST.
        setReload(value => value + 1);
      }
    }
  }

  const batch = result?.batch;
  const running = active(batch);
  return (
    <div className="w-full basis-full space-y-2 text-sm text-[var(--fp-graphite)]">
      <Button className="w-full sm:w-auto" aria-describedby={scopeId}
        disabled={reading || sending || running || result?.configured !== true} onClick={() => { void send(); }}>
        {sending || running ? <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
          : <Send className="h-4 w-4" aria-hidden="true" />}
        {config.label}
      </Button>
      <p id={scopeId} className="text-xs leading-5 text-[var(--fp-muted)]">{config.scope}</p>
      <p className="text-xs leading-5 text-[var(--fp-client-green)]">Excluye créditos con prórroga o excepción vigente.</p>
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1">
        {reading && !batch ? <p className="text-[var(--fp-muted)]">Consultando estado…</p> : null}
        {sending ? <p>Solicitando el lote…</p> : null}
        {batch ? <>
          <p>{running ? "Lote en proceso" : "Lote finalizado"}{batch.dateKey ? ` · ${batch.dateKey}` : ""}.</p>
          {batch.status === "COMPLETED" && batch.total === 0
            ? <p>{config.empty}</p>
            : <p className="text-[var(--fp-muted)]">Aceptados por WhatsApp: {count.format(batch.accepted)} · Pendientes: {count.format(batch.pending)} · Fallidos: {count.format(batch.failed)} · Sin confirmar: {count.format(batch.unknown)} · Omitidos: {count.format(batch.skipped)}.</p>}
          {batch.excludedActiveMoraProtection !== undefined
            ? <p className="text-[var(--fp-client-green)]">Excluidos por prórroga o excepción al crear el lote: {count.format(batch.excludedActiveMoraProtection)} créditos.</p> : null}
        </> : null}
        {result?.configured === false ? <p className="text-[var(--fp-muted)]">El envío por WhatsApp no está disponible en este momento.</p> : null}
      </div>
      {error ? <div className="space-y-1">
        <p role="alert" className="text-[var(--fp-danger)]">{error}</p>
        <Button variant="ghost" disabled={reading || sending} onClick={() => { setReading(true); setReload(value => value + 1); }}>Actualizar estado</Button>
      </div> : null}
    </div>
  );
}
