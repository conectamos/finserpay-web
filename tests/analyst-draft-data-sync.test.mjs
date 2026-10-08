import assert from "node:assert/strict";
import test from "node:test";
import {
  readAnalystDraftDataSnapshot,
  resolveAnalystDraftDataUpdate,
  startVisibleDraftDataPolling,
} from "../lib/analyst-draft-data-sync.ts";

function payload(revision, values, fieldRevisions = {}) {
  return {
    analystDataRevision: revision,
    analystDataCorrection: { revision, fields: Object.keys(values), values, fieldRevisions },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("solo lee datos de cliente autorizados y revisiones enteras", () => {
  const result = readAnalystDraftDataSnapshot(12, payload(2, {
    clienteTelefono: "3000000001", valorEquipoTotal: "100", imei: "123456789012345",
    clienteDocumento: "11111111", clienteCorreo: 4,
  }, { clienteTelefono: 2, imei: 2 }));
  assert.deepEqual(result.values, { clienteTelefono: "3000000001" });
  assert.deepEqual(result.fieldRevisions, { clienteTelefono: 2 });
  assert.equal(readAnalystDraftDataSnapshot(12, payload(-1, {})).revision, 0);
  assert.deepEqual(readAnalystDraftDataSnapshot(12, {
    analystDataRevision: 2,
    analystDataCorrection: { revision: 1, fields: ["clienteTelefono"], values: { clienteTelefono: "viejo" } },
  }).values, {});
});

test("la actualización conserva el equipo, plan, evidencia y campos locales no corregidos", () => {
  const previous = readAnalystDraftDataSnapshot(12, {});
  const update = resolveAnalystDraftDataUpdate(previous, 12,
    payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 }));
  const local = { clienteTelefono: "3000000000", clienteCorreo: "asesor@example.test",
    valorEquipoTotal: "4200000", cuotaInicial: "1500000", plazoMeses: "40",
    imei: "123456789012345", fotoRemisionDataUrl: "evidencia-local" };
  assert.deepEqual({ ...local, ...update.values }, { ...local, clienteTelefono: "3000000001" });
  assert.equal(update.snapshot.revision, 1);
});

test("la misma revisión no vuelve a sobrescribir un dato que el asesor editó después", () => {
  const saved = payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 });
  const previous = readAnalystDraftDataSnapshot(12, saved);
  assert.equal(resolveAnalystDraftDataUpdate(previous, 12, saved), null);
});

test("descarta respuestas fuera de orden y de otra solicitud", () => {
  const previous = readAnalystDraftDataSnapshot(12, payload(3, { clienteTelefono: "3000000003" }));
  assert.equal(resolveAnalystDraftDataUpdate(previous, 12, payload(2, { clienteTelefono: "3000000002" })), null);
  assert.equal(resolveAnalystDraftDataUpdate(previous, 13, payload(4, { clienteTelefono: "3000000004" })), null);
});

test("una segunda corrección no repone campos ya reconocidos de la primera", () => {
  const previous = readAnalystDraftDataSnapshot(12,
    payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 }));
  const next = payload(2, { clienteTelefono: "3000000002", clienteCorreo: "corregido@example.test" },
    { clienteTelefono: 1, clienteCorreo: 2 });
  assert.deepEqual(resolveAnalystDraftDataUpdate(previous, 12, next).values,
    { clienteCorreo: "corregido@example.test" });
});

test("la revisión por campo reconoce un valor histórico restablecido por el analista", () => {
  const previous = readAnalystDraftDataSnapshot(12,
    payload(1, { clienteTelefono: "3000000001" }, { clienteTelefono: 1 }));
  const update = resolveAnalystDraftDataUpdate(previous, 12,
    payload(2, { clienteTelefono: "3000000001" }, { clienteTelefono: 2 }));
  assert.deepEqual(update.values, { clienteTelefono: "3000000001" });
});

test("para marcadores previos sin revisión por campo aplica solamente valores modificados", () => {
  const previous = readAnalystDraftDataSnapshot(12, payload(1, { clienteTelefono: "3000000001" }));
  const next = payload(2, { clienteTelefono: "3000000001", clienteCorreo: "nuevo@example.test" });
  assert.deepEqual(resolveAnalystDraftDataUpdate(previous, 12, next).values,
    { clienteCorreo: "nuevo@example.test" });
});

function pollingHarness(load) {
  const requests = [];
  const applied = [];
  const timers = new Map();
  let timerId = 0;
  let visible = true;
  const polling = startVisibleDraftDataPolling({
    load: (signal) => { requests.push(signal); return load(signal); },
    apply: (value) => applied.push(value),
    isVisible: () => visible,
    schedule: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    cancel: (id) => timers.delete(id),
  });
  return { polling, requests, applied, timers, setVisible: (value) => { visible = value; } };
}

test("una consulta en vuelo no se duplica al volver el foco y programa la siguiente en cinco segundos", async () => {
  let resolve;
  const harness = pollingHarness(() => new Promise((done) => { resolve = done; }));
  harness.polling.refresh();
  harness.polling.refresh();
  assert.equal(harness.requests.length, 1);
  resolve("datos");
  await flush();
  assert.deepEqual(harness.applied, ["datos"]);
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].delay, 5_000);
  harness.polling.stop();
  assert.equal(harness.timers.size, 0);
});

test("al desmontar o cambiar la solicitud aborta y descarta una respuesta tardía", async () => {
  let resolve;
  const harness = pollingHarness(() => new Promise((done) => { resolve = done; }));
  harness.polling.stop();
  assert.equal(harness.requests[0].aborted, true);
  resolve("solicitud anterior");
  await flush();
  harness.polling.refresh();
  assert.deepEqual(harness.applied, []);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.requests.length, 1);
});

test("ocultar la pestaña detiene lecturas y volver a verla sincroniza sin esperar el intervalo", async () => {
  const harness = pollingHarness(async () => "datos");
  await flush();
  harness.setVisible(false);
  harness.polling.refresh();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.requests.length, 1);
  harness.setVisible(true);
  harness.polling.refresh();
  await flush();
  assert.equal(harness.requests.length, 2);
  harness.polling.stop();
});

test("si la pestaña se oculta durante la lectura no aplica la respuesta", async () => {
  let resolve;
  const harness = pollingHarness(() => new Promise((done) => { resolve = done; }));
  harness.setVisible(false);
  harness.polling.refresh();
  assert.equal(harness.requests[0].aborted, true);
  resolve("datos");
  await flush();
  assert.deepEqual(harness.applied, []);
  assert.equal(harness.timers.size, 0);
  harness.polling.stop();
});

test("un error temporal de lectura conserva la pantalla y permite reintentar", async () => {
  let attempts = 0;
  const harness = pollingHarness(async () => {
    if (++attempts === 1) throw new Error("sin conexión");
    return "recuperado";
  });
  await flush();
  assert.deepEqual(harness.applied, []);
  const retry = [...harness.timers.values()][0];
  retry.callback();
  await flush();
  assert.deepEqual(harness.applied, ["recuperado"]);
  harness.polling.stop();
});
