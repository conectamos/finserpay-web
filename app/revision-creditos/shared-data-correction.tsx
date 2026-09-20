"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Pencil, RefreshCw, X } from "lucide-react";
import { Button, Card, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  ApprovalRequestError,
  readApprovalData,
  readApprovalEquipmentCatalog,
  updateApprovalData,
  type ApprovalDataChanges,
  type ApprovalDetail,
  type ApprovalEditableData,
  type ApprovalEquipmentCatalogItem,
} from "@/app/dashboard/aprobaciones/approval-client";
import {
  COLOMBIA_DEPARTMENT_OPTIONS,
  getColombiaCityOptions,
  getColombiaDepartmentLabel,
} from "@/lib/colombia-locations";

type Props = {
  detail: ApprovalDetail;
  disabled: boolean;
  onUpdated: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onOpenHistory: () => void;
};

type Values = {
  clienteCorreo: string;
  clienteTelefono: string;
  clienteDepartamento: string;
  clienteCiudad: string;
  clienteDireccion: string;
  catalogItemId: string;
};

type SummaryRow = { label: string; before: string; after: string };
type PendingUpdate = {
  changes: ApprovalDataChanges;
  reason: string;
  revision: number;
  reviewHash: string;
  idempotencyKey: string;
  signature: string;
  summary: SummaryRow[];
};

const emptyValues: Values = {
  clienteCorreo: "",
  clienteTelefono: "",
  clienteDepartamento: "",
  clienteCiudad: "",
  clienteDireccion: "",
  catalogItemId: "",
};

function clean(value: string | null | undefined) {
  return String(value || "").trim();
}

function comparable(value: string | null | undefined) {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function shown(value: string | null | undefined) {
  return clean(value) || "No disponible";
}

function initialValues(item: ApprovalEditableData): Values {
  return {
    clienteCorreo: clean(item.clienteCorreo),
    clienteTelefono: clean(item.clienteTelefono),
    // In /datos this field is the persisted code; the human-readable value is
    // clienteDepartamentoLabel. Never derive or submit a code from that label.
    clienteDepartamento: clean(item.clienteDepartamento),
    clienteCiudad: clean(item.clienteCiudad),
    clienteDireccion: clean(item.clienteDireccion),
    catalogItemId: "",
  };
}

function confirmationText(rows: SummaryRow[]) {
  const changes = rows.map((row) => `${row.label}: “${row.before}” → “${row.after}”.`).join(" ");
  return `${changes} La corrección quedará en el historial y el expediente requerirá una nueva revisión antes de aprobarse.`;
}

export default function SharedDataCorrection({
  detail,
  disabled,
  onUpdated,
  onBusyChange,
  onOpenHistory,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ApprovalEditableData | null>(null);
  const [catalog, setCatalog] = useState<ApprovalEquipmentCatalogItem[]>([]);
  const [values, setValues] = useState<Values>(emptyValues);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadController = useRef<AbortController | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    onBusyChange(editing || loading || saving || confirming);
    return () => onBusyChange(false);
  }, [editing, loading, saving, confirming, onBusyChange]);

  useEffect(() => {
    loadController.current?.abort();
    setEditing(false);
    setLoading(false);
    setSaving(false);
    setData(null);
    setCatalog([]);
    setValues(emptyValues);
    setReason("");
    setPending(null);
    setConfirming(false);
    setError("");
    setNotice("");
    return () => loadController.current?.abort();
  }, [detail.id]);

  const departmentOptions = useMemo(() => {
    const current = clean(data?.clienteDepartamento);
    if (!current || COLOMBIA_DEPARTMENT_OPTIONS.some((option) => option.value === current)) {
      return [...COLOMBIA_DEPARTMENT_OPTIONS];
    }
    return [
      ...COLOMBIA_DEPARTMENT_OPTIONS,
      { value: current, label: `${getColombiaDepartmentLabel(current)} (valor actual)` },
    ];
  }, [data?.clienteDepartamento]);

  const cityOptions = useMemo(() => {
    let options = [...getColombiaCityOptions(values.clienteDepartamento, data?.clienteCiudad || "")];
    const current = clean(data?.clienteCiudad);
    const preservingDepartment = comparable(values.clienteDepartamento) === comparable(data?.clienteDepartamento);
    if (preservingDepartment && current) {
      options = options.filter((city) => comparable(city) !== comparable(current));
      options.push(current);
    }
    return options;
  }, [data?.clienteCiudad, data?.clienteDepartamento, values.clienteDepartamento]);

  const compatibleCatalog = useMemo(() => {
    const platform = comparable(data?.plataforma);
    return platform ? catalog.filter((item) => comparable(item.plataforma) === platform) : catalog;
  }, [catalog, data?.plataforma]);

  async function loadEditor() {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setEditing(true);
    setLoading(true);
    setError("");
    setNotice("");
    setPending(null);
    setConfirming(false);
    try {
      const [dataResponse, catalogItems] = await Promise.all([
        readApprovalData(detail.id, controller.signal),
        readApprovalEquipmentCatalog(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setData(dataResponse.item);
      setCatalog(catalogItems);
      setValues(initialValues(dataResponse.item));
      setReason("");
      window.requestAnimationFrame(() => document.getElementById(`approval-data-email-${detail.id}`)?.focus());
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "No fue posible preparar la edición.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function closeEditor() {
    if (submitting.current) return;
    loadController.current?.abort();
    setEditing(false);
    setLoading(false);
    setData(null);
    setCatalog([]);
    setValues(emptyValues);
    setReason("");
    setPending(null);
    setConfirming(false);
    setError("");
    window.requestAnimationFrame(() => document.getElementById(`approval-data-edit-${detail.id}`)?.focus());
  }

  function prepareConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || saving || submitting.current || !data.capabilities.canEditData) return;
    const changes: ApprovalDataChanges = {};
    const summary: SummaryRow[] = [];
    const addTextChange = (
      field: "clienteCorreo" | "clienteTelefono" | "clienteDepartamento" | "clienteCiudad" | "clienteDireccion",
      label: string,
      before: string | null,
      after: string
    ) => {
      const next = clean(after);
      if (next === clean(before)) return;
      changes[field] = next;
      summary.push({
        label,
        before: field === "clienteDepartamento" ? shown(getColombiaDepartmentLabel(before)) : shown(before),
        after: field === "clienteDepartamento" ? shown(getColombiaDepartmentLabel(next)) : shown(next),
      });
    };

    addTextChange("clienteCorreo", "Correo", data.clienteCorreo, values.clienteCorreo);
    addTextChange("clienteTelefono", "Teléfono", data.clienteTelefono, values.clienteTelefono);
    addTextChange("clienteDepartamento", "Departamento", data.clienteDepartamento, values.clienteDepartamento);
    addTextChange("clienteCiudad", "Ciudad", data.clienteCiudad, values.clienteCiudad);
    addTextChange("clienteDireccion", "Dirección", data.clienteDireccion, values.clienteDireccion);

    if (values.catalogItemId) {
      const catalogItem = compatibleCatalog.find((item) => String(item.id) === values.catalogItemId);
      if (!catalogItem) {
        setError("Selecciona una referencia disponible en el catálogo.");
        return;
      }
      if (comparable(catalogItem.referenciaEquipo) !== comparable(data.referenciaEquipo)) {
        changes.catalogItemId = catalogItem.id;
        summary.push({
          label: "Referencia del equipo",
          before: shown(data.referenciaEquipo),
          after: shown(catalogItem.referenciaEquipo),
        });
      }
    }

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("Escribe el motivo de la corrección.");
      return;
    }
    if (!summary.length) {
      setError("Modifica al menos un dato antes de continuar.");
      return;
    }

    const request = {
      changes,
      reason: trimmedReason,
      revision: data.review.revision,
      reviewHash: data.review.reviewHash,
    };
    const signature = JSON.stringify(request);
    setPending({
      ...request,
      idempotencyKey: pending?.signature === signature ? pending.idempotencyKey : crypto.randomUUID(),
      signature,
      summary,
    });
    setError("");
    setConfirming(true);
  }

  async function save() {
    if (!pending || submitting.current || !data?.capabilities.canEditData) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await updateApprovalData(detail.id, {
        changes: pending.changes,
        reason: pending.reason,
        revision: pending.revision,
        reviewHash: pending.reviewHash,
        idempotencyKey: pending.idempotencyKey,
      });
      setConfirming(false);
      setEditing(false);
      setData(null);
      setCatalog([]);
      setReason("");
      setPending(null);
      setNotice(result.replayed
        ? "La corrección ya había sido confirmada. Se recargó el expediente y su historial."
        : result.unchanged
        ? "La información ya coincidía con la versión vigente. Se actualizó el expediente."
        : "Información actualizada. El expediente volvió a revisión y la corrección quedó en el historial.");
      try {
        await onUpdated();
        onOpenHistory();
      } catch {
        setError("La corrección se guardó, pero no fue posible recargar el expediente. Usa Actualizar antes de continuar.");
      }
      window.requestAnimationFrame(() => document.getElementById(`approval-data-edit-${detail.id}`)?.focus());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "No fue posible guardar la corrección.";
      setError(message);
      setConfirming(false);
      if (cause instanceof ApprovalRequestError && cause.status === 409) {
        setEditing(false);
        setData(null);
        setPending(null);
        try { await onUpdated(); } catch { /* The conflict message already asks for a refresh. */ }
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  if (!detail.capabilities.canEditData) return null;

  return (
    <Card className="min-w-0 space-y-3" aria-labelledby={`approval-data-title-${detail.id}`}>
      <div>
        <h2 id={`approval-data-title-${detail.id}`} className="font-semibold">Información del expediente</h2>
        <p className="mt-2 text-sm text-[var(--fp-muted)]">Corrige datos operativos. Nombre y cédula permanecen protegidos.</p>
      </div>

      {!editing ? (
        <Button id={`approval-data-edit-${detail.id}`} variant="secondary" className="w-full" disabled={disabled} onClick={() => void loadEditor()}>
          <Pencil size={16} aria-hidden="true" />Editar información
        </Button>
      ) : loading ? (
        <LoadingState label="Cargando información y catálogo..." />
      ) : !data ? (
        <div className="space-y-2">
          <Button variant="secondary" disabled={disabled} onClick={() => void loadEditor()}>
            <RefreshCw size={16} aria-hidden="true" />Reintentar
          </Button>
          <Button variant="ghost" onClick={closeEditor}><X size={16} aria-hidden="true" />Cerrar</Button>
        </div>
      ) : !data.capabilities.canEditData ? (
        <div className="space-y-2">
          <p className="text-sm text-[var(--fp-muted)]">{data.capabilities.correctionBlockedReason || "La edición ya no está disponible para este expediente."}</p>
          <Button variant="ghost" onClick={closeEditor}>Cerrar</Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={prepareConfirmation}>
          <fieldset disabled={saving} className="space-y-3">
            <legend className="sr-only">Datos que se pueden corregir</legend>
            <label className="block text-sm font-medium" htmlFor={`approval-data-name-${detail.id}`}>Nombre
              <Input id={`approval-data-name-${detail.id}`} className="mt-1 bg-[var(--fp-bg)]" value={data.clienteNombre} readOnly aria-readonly="true" />
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-document-${detail.id}`}>Cédula
              <Input id={`approval-data-document-${detail.id}`} className="mt-1 bg-[var(--fp-bg)]" value={data.clienteDocumento || "No disponible"} readOnly aria-readonly="true" />
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-email-${detail.id}`}>Correo
              <Input id={`approval-data-email-${detail.id}`} className="mt-1" type="text" inputMode="email" autoComplete="email" maxLength={160} value={values.clienteCorreo} onChange={(event) => setValues((current) => ({ ...current, clienteCorreo: event.target.value }))} />
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-phone-${detail.id}`}>Teléfono
              <Input id={`approval-data-phone-${detail.id}`} className="mt-1" type="tel" autoComplete="tel" inputMode="tel" maxLength={30} value={values.clienteTelefono} onChange={(event) => setValues((current) => ({ ...current, clienteTelefono: event.target.value }))} />
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-department-${detail.id}`}>Departamento
              <Select id={`approval-data-department-${detail.id}`} className="mt-1" autoComplete="address-level1" value={values.clienteDepartamento} onChange={(event) => {
                const department = event.target.value;
                setValues((current) => ({
                  ...current,
                  clienteDepartamento: department,
                  clienteCiudad: department === data.clienteDepartamento ? clean(data.clienteCiudad) : "",
                }));
              }}>
                <option value="">Selecciona un departamento</option>
                {departmentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-city-${detail.id}`}>Ciudad o municipio
              <Input id={`approval-data-city-${detail.id}`} className="mt-1" type="text" list={`approval-data-city-options-${detail.id}`} autoComplete="address-level2" disabled={!values.clienteDepartamento || saving} maxLength={120} value={values.clienteCiudad} onChange={(event) => setValues((current) => ({ ...current, clienteCiudad: event.target.value }))} />
              <datalist id={`approval-data-city-options-${detail.id}`}>
                {cityOptions.map((city) => <option key={city} value={city} />)}
              </datalist>
              <span className="mt-1 block text-xs font-normal text-[var(--fp-muted)]">Puedes escribir cualquier municipio. La lista muestra sugerencias del departamento.</span>
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-address-${detail.id}`}>Dirección
              <Input id={`approval-data-address-${detail.id}`} className="mt-1" type="text" autoComplete="street-address" maxLength={220} value={values.clienteDireccion} onChange={(event) => setValues((current) => ({ ...current, clienteDireccion: event.target.value }))} />
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-reference-${detail.id}`}>Referencia del equipo
              <Select id={`approval-data-reference-${detail.id}`} className="mt-1" value={values.catalogItemId} onChange={(event) => setValues((current) => ({ ...current, catalogItemId: event.target.value }))}>
                <option value="">Conservar: {shown(data.referenciaEquipo)}</option>
                {compatibleCatalog.map((item) => <option key={item.id} value={item.id}>{item.referenciaEquipo}</option>)}
              </Select>
              {!compatibleCatalog.length ? <span className="mt-1 block text-xs font-normal text-[var(--fp-muted)]">No hay referencias activas compatibles; puedes conservar el valor actual.</span> : null}
            </label>
            <label className="block text-sm font-medium" htmlFor={`approval-data-reason-${detail.id}`}>Motivo de la corrección
              <Input id={`approval-data-reason-${detail.id}`} className="mt-1" required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explica por qué se corrigen los datos" />
            </label>
          </fieldset>
          <p className="text-xs text-[var(--fp-muted)]">Al guardar, la aprobación vigente se invalida y el expediente vuelve a revisión.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>Revisar cambios</Button>
            <Button variant="ghost" disabled={saving} onClick={closeEditor}><X size={16} aria-hidden="true" />Cancelar</Button>
          </div>
        </form>
      )}

      {error ? <p className="text-sm text-[var(--fp-danger)]" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-[var(--fp-muted)]" role="status" aria-live="polite">{notice}</p> : null}
      <ConfirmDialog
        open={confirming}
        title="Confirmar corrección de información"
        description={pending ? confirmationText(pending.summary) : ""}
        confirmLabel="Guardar y enviar a revisión"
        busy={saving}
        onCancel={() => { if (!submitting.current) setConfirming(false); }}
        onConfirm={() => void save()}
      />
    </Card>
  );
}
