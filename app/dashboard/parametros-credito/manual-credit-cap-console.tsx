"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CircleAlert,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";
import { DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT } from "@/lib/datacredito/policy";
import { ParameterHelp, ParameterSection } from "./credit-parameters-ui";
import styles from "./credit-parameters.module.css";

/**
 * Contrato del endpoint central:
 * GET  -> { items: ManualCreditCapItem[], correlationId? } (listado por estado)
 * POST /buscar -> { documentNumber, estado } (búsqueda exacta privada)
 * POST -> { documentNumber, maxFinancedAmount, reason, mutationId }
 * PATCH -> { id, maxFinancedAmount?, reason?, active?, expectedVersion, mutationId }
 *
 * El servidor nunca devuelve la cédula completa: cada item expone únicamente
 * documentLast4. La cédula completa solo viaja al crear o en una búsqueda exacta.
 */

type ManualCreditCapItem = {
  id: string;
  documentLast4: string;
  maxFinancedAmount: number;
  reason: string;
  active: boolean;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
};

type StatusFilter = "ALL" | "ACTIVE" | "INACTIVE";

type Draft = {
  documentNumber: string;
  maxFinancedAmount: string;
  reason: string;
};

type PendingMutation =
  | {
      kind: "CREATE";
      mutationId: string;
      documentNumber: string;
      maxFinancedAmount: number;
      reason: string;
    }
  | {
      kind: "UPDATE";
      mutationId: string;
      item: ManualCreditCapItem;
      maxFinancedAmount: number;
      reason: string;
    }
  | {
      kind: "STATUS";
      mutationId: string;
      item: ManualCreditCapItem;
      active: boolean;
    };

const ENDPOINT = "/api/creditos/datacredito/cupos-manuales";
const EMPTY_DRAFT: Draft = {
  documentNumber: "",
  maxFinancedAmount: "",
  reason: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNullableString(value: unknown) {
  const parsed = readString(value);
  return parsed || null;
}

function parseItem(value: unknown): ManualCreditCapItem | null {
  if (!isRecord(value)) return null;

  const id = readString(value.id);
  const documentLast4 = readString(value.documentLast4).replace(/\D/g, "");
  const maxFinancedAmount = Number(value.maxFinancedAmount);
  const version = Number(value.version);

  if (
    !id ||
    !/^\d{3,4}$/.test(documentLast4) ||
    !Number.isInteger(maxFinancedAmount) ||
    maxFinancedAmount <= 0 ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return null;
  }

  return {
    id,
    documentLast4,
    maxFinancedAmount,
    reason: readString(value.reason),
    active: value.active === true,
    version,
    createdAt: readNullableString(value.createdAt),
    updatedAt: readNullableString(value.updatedAt),
  };
}

function parseItems(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.map(parseItem).filter((item): item is ManualCreditCapItem => Boolean(item));
}

function readError(payload: unknown, fallback: string) {
  if (!isRecord(payload)) return fallback;
  return readString(payload.error) || readString(payload.message) || fallback;
}

function readCorrelationId(payload: unknown) {
  return isRecord(payload) ? readNullableString(payload.correlationId) : null;
}

function onlyDigits(value: string, maxLength = 13) {
  return value.replace(/\D/g, "").slice(0, maxLength);
}

function parseMoney(value: string) {
  const parsed = Number(value.replace(/\D/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatCop(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "$ 0";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

function maskedDocument(last4: string) {
  return `•••• ${last4}`;
}

function newMutationId() {
  return crypto.randomUUID();
}

export default function ManualCreditCapConsole() {
  const [items, setItems] = useState<ManualCreditCapItem[]>([]);
  const [searchValue, setSearchValue] = useState("");
  const [documentFilter, setDocumentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingItem, setEditingItem] = useState<ManualCreditCapItem | null>(null);
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const mutationBusyRef = useRef(false);

  const loadItems = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    setCorrelationId(null);

    try {
      const params = new URLSearchParams({ estado: statusFilter });
      const exactSearch = Boolean(documentFilter);
      const response = await fetch(
        exactSearch ? `${ENDPOINT}/buscar` : `${ENDPOINT}?${params.toString()}`,
        {
        method: exactSearch ? "POST" : "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: exactSearch ? { "Content-Type": "application/json" } : undefined,
        body: exactSearch
          ? JSON.stringify({ documentNumber: documentFilter, estado: statusFilter })
          : undefined,
        signal: controller.signal,
        }
      );
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readError(payload, "No fue posible cargar los cupos manuales."));
        setCorrelationId(readCorrelationId(payload));
        return;
      }

      if (loadAbortRef.current === controller) setItems(parseItems(payload));
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setError("No fue posible comunicarse con el servidor. Intenta nuevamente.");
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [documentFilter, statusFilter]);

  useEffect(() => {
    void loadItems();
    return () => loadAbortRef.current?.abort();
  }, [loadItems]);

  const parsedAmount = useMemo(
    () => parseMoney(draft.maxFinancedAmount),
    [draft.maxFinancedAmount]
  );

  const beginCreate = (documentNumber = "") => {
    setEditingItem(null);
    setDraft({ ...EMPTY_DRAFT, documentNumber });
    setFormError(null);
    setNotice(null);
  };

  const beginEdit = (item: ManualCreditCapItem) => {
    setEditingItem(item);
    setDraft({
      documentNumber: maskedDocument(item.documentLast4),
      maxFinancedAmount: String(item.maxFinancedAmount),
      reason: item.reason,
    });
    setFormError(null);
    setNotice(null);
    document.getElementById("manual-credit-cap-form")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const cancelEdit = () => {
    setEditingItem(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = onlyDigits(searchValue);
    if (normalized && !/^\d{3,13}$/.test(normalized)) {
      setSearchError("Ingresa la cédula completa: entre 3 y 13 dígitos.");
      return;
    }
    setSearchError(null);
    setDocumentFilter(normalized);
    if (normalized === documentFilter) void loadItems();
  };

  const clearSearch = () => {
    setSearchValue("");
    setDocumentFilter("");
    setSearchError(null);
    setNotice(null);
    if (!documentFilter) void loadItems();
  };

  const prepareSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutationBusyRef.current) return;
    const amount = parsedAmount;
    const reason = draft.reason.trim();

    if (!editingItem && !/^\d{3,13}$/.test(draft.documentNumber)) {
      setFormError("La cédula debe contener entre 3 y 13 dígitos.");
      return;
    }
    if (
      amount === null ||
      amount <= 0 ||
      amount > DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT
    ) {
      setFormError(
        `El cupo debe estar entre $ 1 y ${formatCop(DATACREDITO_MAX_FINANCED_AMOUNT_LIMIT)}.`
      );
      return;
    }
    if (reason.length < 5 || reason.length > 240) {
      setFormError("La razón debe tener entre 5 y 240 caracteres.");
      return;
    }

    setFormError(null);
    setMutationError(null);
    setPendingMutation(
      editingItem
        ? {
            kind: "UPDATE",
            mutationId: newMutationId(),
            item: editingItem,
            maxFinancedAmount: amount,
            reason,
          }
        : {
            kind: "CREATE",
            mutationId: newMutationId(),
            documentNumber: draft.documentNumber,
            maxFinancedAmount: amount,
            reason,
          }
    );
  };

  const prepareStatusChange = (item: ManualCreditCapItem) => {
    if (mutationBusyRef.current) return;
    setMutationError(null);
    setPendingMutation({
      kind: "STATUS",
      mutationId: newMutationId(),
      item,
      active: !item.active,
    });
  };

  const executeMutation = async () => {
    if (!pendingMutation || mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    setMutationError(null);
    setCorrelationId(null);

    const method = pendingMutation.kind === "CREATE" ? "POST" : "PATCH";
    const body =
      pendingMutation.kind === "CREATE"
        ? {
            documentNumber: pendingMutation.documentNumber,
            maxFinancedAmount: pendingMutation.maxFinancedAmount,
            reason: pendingMutation.reason,
            mutationId: pendingMutation.mutationId,
          }
        : pendingMutation.kind === "UPDATE"
          ? {
              id: pendingMutation.item.id,
              maxFinancedAmount: pendingMutation.maxFinancedAmount,
              reason: pendingMutation.reason,
              expectedVersion: pendingMutation.item.version,
              mutationId: pendingMutation.mutationId,
            }
          : {
              id: pendingMutation.item.id,
              reason: pendingMutation.item.reason,
              active: pendingMutation.active,
              expectedVersion: pendingMutation.item.version,
              mutationId: pendingMutation.mutationId,
            };

    try {
      const response = await fetch(ENDPOINT, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const mutationMessage = readError(payload, "No fue posible guardar el cupo manual.");
        setError(mutationMessage);
        setMutationError(mutationMessage);
        setCorrelationId(readCorrelationId(payload));
        return;
      }

      const successMessage =
        pendingMutation.kind === "CREATE"
          ? "Cupo manual creado correctamente."
          : pendingMutation.kind === "UPDATE"
            ? "Cupo manual actualizado correctamente."
            : pendingMutation.active
              ? "Cupo manual reactivado correctamente."
              : "Cupo manual desactivado correctamente.";

      setNotice(successMessage);
      setPendingMutation(null);
      if (pendingMutation.kind !== "STATUS") cancelEdit();
      await loadItems();
    } catch {
      setError("No fue posible comunicarse con el servidor. Intenta nuevamente.");
      setMutationError("No fue posible comunicarse con el servidor. Intenta nuevamente.");
    } finally {
      mutationBusyRef.current = false;
      setSaving(false);
    }
  };

  const confirmation = useMemo(() => {
    if (!pendingMutation) return null;
    if (pendingMutation.kind === "CREATE") {
      return {
        title: "Crear cupo manual",
        description: `Se asignará un cupo máximo de ${formatCop(
          pendingMutation.maxFinancedAmount
        )} a la cédula terminada en ${pendingMutation.documentNumber.slice(-4)}. Este cupo no aprueba por sí solo una solicitud rechazada.`,
        label: "Crear cupo",
        danger: false,
      };
    }
    if (pendingMutation.kind === "UPDATE") {
      return {
        title: "Actualizar cupo manual",
        description: `El cupo de ${maskedDocument(
          pendingMutation.item.documentLast4
        )} cambiará a ${formatCop(pendingMutation.maxFinancedAmount)}. La nueva regla se aplicará a las financiaciones que se validen después de guardarla.`,
        label: "Actualizar cupo",
        danger: false,
      };
    }
    return pendingMutation.active
      ? {
          title: "Reactivar cupo manual",
          description: `Se volverá a aplicar el cupo especial de ${formatCop(
            pendingMutation.item.maxFinancedAmount
          )} a la cédula ${maskedDocument(pendingMutation.item.documentLast4)}.`,
          label: "Reactivar cupo",
          danger: false,
        }
      : {
          title: "Desactivar cupo manual",
          description: `La cédula ${maskedDocument(
            pendingMutation.item.documentLast4
          )} volverá a usar el máximo definido por su política DataCrédito. El registro y su auditoría se conservarán.`,
          label: "Desactivar cupo",
          danger: true,
        };
  }, [pendingMutation]);

  return (
    <section className={styles.tabContent} aria-label="Cupos máximos por cédula">
      {notice ? (
        <div
          className={styles.notice}
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}

      {error ? (
        <div
          className={styles.error}
          role="alert"
        >
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <strong>{error}</strong>
              {correlationId ? (
                <span className="mt-1 block break-all text-xs">
                  Código de seguimiento: <code>{correlationId}</code>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <ParameterSection
        title="Cupos por cédula"
        action={
          <div className={styles.actions}>
            <ParameterHelp title="Consulta y aplicación del cupo">
              Busca con la cédula completa. El listado protege el documento y muestra
              solo sus últimos cuatro dígitos. Una regla activa sustituye solo el
              cupo de la política; no aprueba una evaluación rechazada ni omite
              DataCrédito o la validación facial.
            </ParameterHelp>
            <Button variant="secondary" onClick={() => void loadItems()} disabled={loading || saving}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Actualizar
            </Button>
          </div>
        }
      >

          <form className={styles.lookup} onSubmit={submitSearch}>
            <label className={styles.field} htmlFor="manual-cap-search">
              Buscar cédula exacta
              <Input
                id="manual-cap-search"
                type="search"
                inputMode="numeric"
                autoComplete="off"
                maxLength={13}
                value={searchValue}
                onChange={(event) => setSearchValue(onlyDigits(event.target.value))}
                placeholder="Cédula completa"
                disabled={loading}
                aria-invalid={Boolean(searchError)}
                aria-describedby={searchError ? "manual-cap-search-error" : undefined}
              />
            </label>
            <label className={styles.field} htmlFor="manual-cap-status">
              Estado
              <Select
                id="manual-cap-status"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                disabled={loading}
              >
                <option value="ALL">Todos</option>
                <option value="ACTIVE">Activos</option>
                <option value="INACTIVE">Inactivos</option>
              </Select>
            </label>
            <div className={styles.actions}>
              <Button type="submit" disabled={loading} className="flex-1 md:flex-none">
                <Search className="h-4 w-4" aria-hidden="true" />
                Buscar
              </Button>
              {documentFilter || searchValue ? (
                <Button type="button" variant="ghost" onClick={clearSearch} disabled={loading}>
                  Limpiar
                </Button>
              ) : null}
            </div>
          </form>

          {searchError ? (
            <p id="manual-cap-search-error" className={styles.error} role="alert">
              {searchError}
            </p>
          ) : null}

          {documentFilter ? (
            <div className={styles.toolbar}>
              <Badge>Búsqueda exacta</Badge>
              <span className={styles.muted}>
                Cédula terminada en {documentFilter.slice(-4)}
              </span>
            </div>
          ) : null}

          {loading ? (
            <div className="py-12">
              <LoadingState label="Cargando cupos manuales..." />
            </div>
          ) : items.length ? (
            <DataTable className={styles.table}>
              <table className="min-w-[900px]">
                <thead>
                  <tr>
                    <th scope="col">Cédula</th>
                    <th scope="col">Cupo máximo</th>
                    <th scope="col">Razón</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Actualización</th>
                    <th scope="col" className="text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong className="font-black text-[var(--fp-graphite)]">
                          {maskedDocument(item.documentLast4)}
                        </strong>
                      </td>
                      <td className="font-black tabular-nums">{formatCop(item.maxFinancedAmount)}</td>
                      <td className="max-w-xs whitespace-normal text-sm leading-5 text-[var(--fp-muted)]">
                        {item.reason || "Sin razón registrada"}
                      </td>
                      <td>
                        <StatusPill tone={item.active ? "positive" : "neutral"}>
                          {item.active ? "Activo" : "Inactivo"}
                        </StatusPill>
                      </td>
                      <td>
                        <span className="block text-sm">{formatDate(item.updatedAt)}</span>
                        <span className="mt-1 block text-sm text-[var(--fp-muted)]">Versión {item.version}</span>
                      </td>
                      <td>
                        <div className={styles.actions}>
                          <Button
                            variant="secondary"
                            onClick={() => beginEdit(item)}
                            disabled={saving}
                            aria-label={`Editar cupo de cédula terminada en ${item.documentLast4}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                            Editar
                          </Button>
                          <Button
                            variant={item.active ? "danger" : "secondary"}
                            onClick={() => prepareStatusChange(item)}
                            disabled={saving}
                            aria-label={`${item.active ? "Desactivar" : "Reactivar"} cupo de cédula terminada en ${item.documentLast4}`}
                          >
                            {item.active ? "Desactivar" : "Reactivar"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          ) : (
            <EmptyState
              className={styles.empty}
              title={documentFilter ? "La cédula no tiene un cupo manual" : "No hay cupos para mostrar"}
              description={
                documentFilter
                  ? "Verifica la cédula exacta o crea una nueva regla desde el formulario."
                  : statusFilter === "ALL"
                    ? "Crea la primera regla para asignar un máximo financiable especial."
                    : "Cambia el filtro de estado para revisar otros registros."
              }
              action={
                documentFilter ? (
                  <Button variant="secondary" onClick={() => beginCreate(documentFilter)}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Crear cupo
                  </Button>
                ) : undefined
              }
            />
          )}
      </ParameterSection>

      <ParameterSection
        id="manual-credit-cap-form"
        title={editingItem ? "Actualizar cupo" : "Asignar cupo manual"}
        action={
          <div className={styles.actions}>
            {editingItem ? <StatusPill tone="warning">Editando</StatusPill> : null}
            <Badge tone="warning">Aplicación financiera inmediata</Badge>
            <ParameterHelp title="Protección de la cédula">
              La cédula se usa solo para crear la regla y nunca se muestra completa
              en el listado. Al editar permanece enmascarada y no se puede cambiar.
              Crear, actualizar, desactivar o reactivar requiere confirmación;
              el registro y su auditoría se conservan.
            </ParameterHelp>
          </div>
        }
      >
        <form className={styles.form} onSubmit={prepareSave} noValidate>
          <div className={styles.formGrid}>
            <label className={styles.field} htmlFor="manual-cap-document">
              Cédula
              <Input
                id="manual-cap-document"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={13}
                value={draft.documentNumber}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    documentNumber: onlyDigits(event.target.value),
                  }))
                }
                placeholder="Número de documento"
                disabled={Boolean(editingItem) || saving}
                aria-describedby={editingItem ? "manual-cap-document-protected" : undefined}
                required
              />
              {editingItem ? (
                <span id="manual-cap-document-protected" className={styles.muted}>
                  Cédula protegida. No se puede cambiar.
                </span>
              ) : null}
            </label>
            <label className={styles.field} htmlFor="manual-cap-amount">
              Cupo máximo financiable (COP)
              <Input
                id="manual-cap-amount"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={draft.maxFinancedAmount}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    maxFinancedAmount: onlyDigits(event.target.value, 12),
                  }))
                }
                placeholder="Valor en pesos"
                disabled={saving}
                aria-describedby="manual-cap-amount-preview"
                required
              />
              <span id="manual-cap-amount-preview" className={styles.muted}>
                {formatCop(parsedAmount)}
              </span>
            </label>
          </div>
          <label className={styles.field} htmlFor="manual-cap-reason">
            Razón del cupo
            <textarea
              id="manual-cap-reason"
              className="fp-ui-input min-h-24 resize-y py-3"
              value={draft.reason}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  reason: event.target.value.slice(0, 240),
                }))
              }
              placeholder="Motivo verificable de la asignación"
              maxLength={240}
              disabled={saving}
              aria-describedby="manual-cap-reason-count"
              required
            />
            <span id="manual-cap-reason-count" className={styles.muted}>
              {draft.reason.length}/240
            </span>
          </label>
          {formError ? <p className={styles.error} role="alert">{formError}</p> : null}
          <div className={styles.actions}>
            {editingItem ? (
              <Button type="button" variant="secondary" onClick={cancelEdit} disabled={saving}>
                Cancelar edición
              </Button>
            ) : null}
            <Button type="submit" disabled={saving}>
              {editingItem ? (
                <Pencil className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              {editingItem ? "Revisar actualización" : "Revisar asignación"}
            </Button>
          </div>
        </form>
      </ParameterSection>

      <ConfirmDialog
        open={Boolean(pendingMutation && confirmation)}
        title={confirmation?.title || "Confirmar cupo manual"}
        description={
          mutationError
            ? `${confirmation?.description || "Confirma la operación financiera."} ${mutationError}${correlationId ? ` Código de seguimiento: ${correlationId}.` : ""}`
            : confirmation?.description || "Confirma la operación financiera."
        }
        confirmLabel={confirmation?.label || "Confirmar"}
        danger={confirmation?.danger === true}
        busy={saving}
        onCancel={() => {
          if (!mutationBusyRef.current) setPendingMutation(null);
        }}
        onConfirm={() => void executeMutation()}
      />
    </section>
  );
}
