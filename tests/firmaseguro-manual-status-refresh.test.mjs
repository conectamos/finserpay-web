import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const start = source.indexOf("const refreshFirmaSeguroDraftProcess = async () => {");
const end = source.indexOf("const correctFirmaSeguroImei =", start);
assert.ok(start > 0 && end > start);
const handler = stripTypeScriptTypes(source.slice(start, end));

function fixture(read) {
  const calls = [];
  const notices = [];
  const processes = [];
  const busy = [];
  let retries = 0;
  const context = {
    draftId: 25,
    firmaSeguroDraftProcess: { processUuid: "current" },
    firmaSeguroRefreshFlightRef: { current: null },
    firmaSeguroRefreshGenerationRef: { current: 0 },
    firmaSeguroRefreshBindingRef: { current: { draftId: 25, processUuid: "current" } },
    auditedIdentityCorrectionRef: { current: false },
    AbortController, Error,
    createClientMode: true, iphoneFactory: true,
    processLiveStatus: { retry() { retries += 1; } },
    requestJson: async (url, options) => {
      calls.push({ url, options });
      if (read) return read(url, options);
      return url.includes("refresh=1")
        ? { ok: true, data: { ok: true, process: { processUuid: "current", completedAt: "2026-10-10T00:00:00Z" } } }
        : { ok: true, data: { item: { id: 25, payload: {} } } };
    },
    resolveFirmaSeguroProcessUiState: process => process?.completedAt ? "signed" : "waiting",
    formatFirmaSeguroApiFailure: result => result?.error || "Error de firma",
    formatFirmaSeguroProcessIssue: () => "Error de firma",
    hasAuditedCreditIdentityCorrection: () => false,
    setNotice: value => notices.push(value),
    setFirmaSeguroRefreshing: value => busy.push(value),
    setFirmaSeguroIdentityCorrectionPending() {},
    setFirmaSeguroDraftProcess: value => processes.push(value),
    setFirmaSeguroPendingDraftId() {}, setWizardStep() {},
  };
  const refresh = runInNewContext(handler + "\nrefreshFirmaSeguroDraftProcess", context);
  return { refresh, context, calls, notices, processes, busy, retries: () => retries };
}

test("actualizar consulta el proceso existente por GET y muestra la firma confirmada sin enviar contrato", async () => {
  const f = fixture();
  await f.refresh();
  assert.equal(f.calls[0].url, "/api/creditos/borradores/25/firma-seguro?refresh=1");
  assert.equal(f.calls[0].options.method, "GET");
  assert.equal(f.processes[0].completedAt, "2026-10-10T00:00:00Z");
  assert.equal(f.retries(), 1);
  assert.equal(f.notices.at(-1).tone, "emerald");
  assert.deepEqual(f.busy, [true, false]);
  assert.equal(f.context.firmaSeguroRefreshFlightRef.current, null);
  assert.doesNotMatch(handler, /method: "POST"|submitFirmaSeguroDraft|setInterval/);
});

test("doble clic hace una sola consulta y descarta respuesta al cambiar solicitud", async () => {
  let resolve;
  const f = fixture(async () => new Promise(done => { resolve = done; }));
  const pending = f.refresh();
  await f.refresh();
  assert.equal(f.calls.length, 1);
  f.context.firmaSeguroRefreshBindingRef.current = { draftId: 26, processUuid: "next" };
  resolve({ ok: true, data: { ok: true, process: { processUuid: "current", completedAt: "signed" } } });
  await pending;
  assert.equal(f.processes.length, 0);
  assert.equal(f.calls.length, 1);
});

test("una versión de contrato diferente no sustituye la firma actual", async () => {
  const f = fixture(async () => ({ ok: true, data: { ok: true, process: { processUuid: "old", completedAt: "signed" } } }));
  await f.refresh();
  assert.equal(f.processes.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.notices.at(-1).tone, "red");
  assert.equal(f.retries(), 1);
});

test("errores se muestran y permiten reintentar sin alterar el proceso", async () => {
  const f = fixture(async () => { throw new Error("Sin conexión"); });
  await f.refresh();
  assert.equal(f.notices.at(-1).text, "Sin conexión");
  assert.equal(f.notices.at(-1).tone, "red");
  assert.equal(f.processes.length, 0);
  assert.equal(f.context.firmaSeguroRefreshFlightRef.current, null);
  await f.refresh();
  assert.equal(f.calls.length, 2);
});

test("el botón accesible conserva la actualización automática local y aborta al salir", () => {
  assert.match(source, /aria-label="Actualizar estado de firma"/);
  assert.match(source, /onClick=\{\(\) => void refreshFirmaSeguroDraftProcess\(\)\}/);
  assert.match(source, /firmaSeguroRefreshFlightRef\.current\?\.abort\(\)/);
  assert.match(source, /\[draftId, firmaSeguroDraftProcess\?\.processUuid\]/);
  assert.match(source, /const processLiveStatus = useCreditProcessLiveStatus/);
});
