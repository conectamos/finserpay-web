import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  readApprovalData,
  readApprovalEquipmentCatalog,
  updateApprovalData,
} from "../app/dashboard/aprobaciones/approval-client.ts";

const history = [{
  id: "correction-1",
  changes: [{ field: "clienteDepartamento", before: "TOLIMA", after: "HUILA" }],
  reason: "El cliente confirmó su residencia actual.",
  actorName: "Analista",
  actorKind: "USER",
  createdAt: "2026-09-20T15:30:00.000Z",
}];

function editableItem(overrides = {}) {
  return {
    clienteNombre: "Cliente de prueba",
    clienteDocumento: "1000000000",
    clienteCorreo: "cliente@example.com",
    clienteTelefono: "3000000000",
    clienteDepartamento: "TOLIMA",
    clienteDepartamentoLabel: "TOLIMA",
    clienteCiudad: "Ibague",
    clienteDireccion: "Calle 1 # 2-3",
    referenciaEquipo: "APPLE IPHONE 13",
    plataforma: "IPHONE",
    review: { revision: 3, reviewHash: "a".repeat(64) },
    capabilities: { canEditData: true, correctionBlockedReason: null },
    ...overrides,
  };
}

test("el cliente de correcciones lee código raw, etiqueta e historial en sus niveles contractuales", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/aprobaciones/42/datos");
    assert.deepEqual(init, { cache: "no-store", signal: undefined });
    return new Response(JSON.stringify({
      ok: true,
      item: editableItem({
        clienteDepartamento: "BOGOTA_DC",
        clienteDepartamentoLabel: "BOGOTÁ, D. C.",
      }),
      history,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await readApprovalData(42);
  assert.equal(result.item.clienteDepartamento, "BOGOTA_DC");
  assert.equal(result.item.clienteDepartamentoLabel, "BOGOTÁ, D. C.");
  assert.deepEqual(result.history, history);
});

test("el catálogo solo expone referencias seleccionables con plataforma", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    items: [{
      id: 7,
      marca: "APPLE",
      modelo: "IPHONE 13",
      referenciaEquipo: "APPLE IPHONE 13",
      plataforma: "IPHONE",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  assert.deepEqual(await readApprovalEquipmentCatalog(), [{
    id: 7,
    marca: "APPLE",
    modelo: "IPHONE 13",
    referenciaEquipo: "APPLE IPHONE 13",
    plataforma: "IPHONE",
  }]);
});

test("el PATCH envía solo changes, motivo, revisión, hash e idempotencia", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = {
    changes: { clienteCorreo: "nuevo@example.com", catalogItemId: 7 },
    reason: "El cliente confirmó la corrección.",
    revision: 3,
    reviewHash: "a".repeat(64),
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/aprobaciones/42/datos");
    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(init.body), input);
    return new Response(JSON.stringify({
      ok: true,
      item: editableItem({
        clienteCorreo: "nuevo@example.com",
        review: { revision: 4, reviewHash: "b".repeat(64) },
      }),
      history,
      unchanged: false,
      replayed: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await updateApprovalData(42, input);
  assert.equal(result.item.review.revision, 4);
  assert.equal(result.unchanged, false);
  assert.equal(result.replayed, false);
});
test("el historial sigue visible después de liquidar y el refresco conserva el aviso de cambio de vista", () => {
  const workspace = readFileSync(new URL("../app/revision-creditos/shared-approval-workspace.tsx", import.meta.url), "utf8");
  const consoleSource = readFileSync(new URL("../app/dashboard/aprobaciones/approval-console.tsx", import.meta.url), "utf8");
  assert.match(workspace, /const showHistory = Boolean\(detail\?\.review\.required && selectedItem\);/);
  assert.doesNotMatch(workspace, /showHistory[\s\S]{0,80}!selectedItem\.paid/);
  assert.match(consoleSource, /next\.review\.status === \(view === "approved" \? "APPROVED" : "PENDING"\)[\s\S]{0,160}next\.review\.revision/);
});
