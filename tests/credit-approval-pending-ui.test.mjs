import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "lucide-react";
import ts from "typescript";

function load(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, { module: loadedModule, exports: loadedModule.exports, console, URL, URLSearchParams,
    Response, Request, AbortController, crypto: webcrypto,
    require(name) {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (name === "lucide-react") return icons;
      assert.ok(name in dependencies, `Unexpected dependency ${name} from ${path}`);
      return dependencies[name];
    }, ...globals,
  }, { filename: path });
  return loadedModule.exports;
}

const clientPath = "app/dashboard/pendientes/pending-client.ts";
const sample = {
  id: 81, folio: "QA-0081", clienteNombre: "Cliente de prueba", clienteDocumento: "12345", aliadoNombre: "Aliado QA",
  sedeNombre: "Sede QA", fechaCredito: "2026-09-09T12:00:00Z",
  novelty: { id: "novelty-1", status: "WAITING_ALLY", version: 2, pendingCount: 2, answeredCount: 0, items: [] },
  canRespond: true, blockedReason: null,
};
const photo = { id: "issue-1", key: "foto-entrega", label: "Foto de entrega", status: "OPEN", version: 3,
  reason: "La entrega no se alcanza a ver", openedAt: "2026-09-09T12:00:00Z", respondedAt: null,
  evidence: { available: true, href: "/api/pendientes/81/evidencias?tipo=foto-entrega&v=abc", sha256: "a".repeat(64) } };
const photoInput = { noveltyId: sample.novelty.id, itemId: photo.id, expectedVersion: photo.version,
  expectedPhotoHash: photo.evidence.sha256, dataUrl: "data:image/png;base64,cGhvdG8=", idempotencyKey: "request-1" };
const json = (body, status = 200) => Response.json(body, { status });

test("el listado conserva cursor, filtro del servidor y señal sin cachear el expediente", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const client = load(clientPath, {}, { fetch: async (...args) => {
    calls.push(args); return json({ items: [sample], hasMore: true, nextCursor: "next/+==" });
  } });
  const result = await client.listPendingCredits({ status: "WAITING_ALLY", cursor: "previous/+==" }, signal);
  const url = new URL(calls[0][0], "https://qa.invalid");
  assert.equal(url.pathname, "/api/pendientes");
  assert.equal(url.searchParams.get("status"), "WAITING_ALLY");
  assert.equal(url.searchParams.get("cursor"), "previous/+==");
  assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(result.nextCursor, "next/+==");
});

test("un listado vacío es válido y una paginación o estado inválidos no se muestran como éxito", async () => {
  for (const body of [{ items: [], hasMore: false, nextCursor: null }, { items: [], hasMore: true, nextCursor: null },
    { items: [{ ...sample, novelty: { ...sample.novelty, status: "APPROVED" } }], hasMore: false, nextCursor: null }]) {
    const client = load(clientPath, {}, { fetch: async () => json(body) });
    if (body.items.length === 0 && !body.hasMore) assert.equal((await client.listPendingCredits()).items.length, 0);
    else await assert.rejects(client.listPendingCredits(), { name: "PendingRequestError" });
  }
});

test("el detalle no acepta otro crédito ni información sin capacidades", async () => {
  for (const item of [{ ...sample, id: 82 }, { ...sample, canRespond: undefined }, null]) {
    const client = load(clientPath, {}, { fetch: async () => json({ item }) });
    await assert.rejects(client.readPendingCredit(81), /no corresponden/);
  }
  const client = load(clientPath, {}, { fetch: async (url, init) => {
    assert.equal(url, "/api/pendientes/81"); assert.equal(init.cache, "no-store"); return json({ item: sample });
  } });
  assert.equal((await client.readPendingCredit(81)).id, 81);
});

test("guardar foto envía únicamente el ítem rechazado con su versión/hash e idempotencia", async () => {
  const calls = [];
  const client = load(clientPath, {}, { fetch: async (...args) => { calls.push(args); return json({ ok: true, unchanged: false }); } });
  await client.respondPendingPhoto(81, photoInput);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/pendientes/81/evidencias");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0][1].body), photoInput);
  assert.equal(JSON.parse(calls[0][1].body).expectedVersion, photo.version);
  assert.notEqual(JSON.parse(calls[0][1].body).expectedVersion, sample.novelty.version);
});

test("guardar una respuesta general usa su endpoint sin foto ni paso de envío adicional", async () => {
  let calls = 0;
  const input = { noveltyId: "novelty-1", itemId: "issue-general", expectedVersion: 1, text: "Novedad resuelta", idempotencyKey: "request-2" };
  const client = load(clientPath, {}, { fetch: async (url, init) => {
    calls++; assert.equal(url, "/api/pendientes/81/respuesta"); assert.deepEqual(JSON.parse(init.body), input);
    return json({ ok: true, unchanged: true });
  } });
  assert.equal((await client.respondPendingText(81, input)).unchanged, true);
  assert.equal(calls, 1);
});

test("conflictos, permisos y respuestas inciertas no reintentan la escritura", async (t) => {
  for (const status of [400, 401, 403, 409, 500]) await t.test(String(status), async () => {
    let calls = 0;
    const client = load(clientPath, {}, { fetch: async () => { calls++; return json({ ok: false, error: "Revisa el estado" }, status); } });
    await assert.rejects(client.respondPendingPhoto(81, photoInput), { name: "PendingRequestError", status, message: "Revisa el estado" });
    assert.equal(calls, 1);
  });
  for (const result of [json({ ok: true }), json({ ok: false }), new Response("not-json"), new Error("network")]) {
    let calls = 0;
    const client = load(clientPath, {}, { fetch: async () => { calls++; if (result instanceof Error) throw result; return result; } });
    await assert.rejects(client.respondPendingPhoto(81, photoInput));
    assert.equal(calls, 1);
  }
});

const ui = load("app/_components/finser-ui.tsx");
const client = load(clientPath);
const confirm = load("app/_components/finser-confirm-dialog.tsx", { "@/app/_components/finser-ui": ui });
const Editor = load("app/dashboard/pendientes/pending-item-editor.tsx", {
  "@/app/_components/finser-ui": ui, "@/app/_components/finser-confirm-dialog": confirm,
  "@/lib/credit-approval-evidence-file": { normalizeEvidenceFile: () => { throw new Error("Unexpected preparation during render"); } },
  "./pending-client": client,
}).default;
const renderEditor = (issue, detail = sample, disabled = false) => renderToStaticMarkup(React.createElement(Editor, {
  issue, detail, disabled, onUpdated: async () => {}, onBusyChange: () => {},
}));

test("cada foto rechazada muestra su motivo y un único selector restringido PNG/JPEG", () => {
  const html = renderEditor(photo);
  assert.match(html, /La entrega no se alcanza a ver/);
  assert.match(html, /aria-label="Reemplazar Foto de entrega"/);
  assert.match(html, /accept="image\/png,image\/jpeg"/);
  assert.equal((html.match(/type="file"/g) || []).length, 1);
  assert.doesNotMatch(html, /<select|Enviar a revisión|Guardar respuesta/);
});

test("una foto respondida queda de solo lectura aunque otra del crédito siga abierta", () => {
  const answered = { ...photo, status: "RESPONDED" };
  const html = renderEditor(answered);
  assert.match(html, /Pendiente revisión analista/);
  assert.match(html, /solo admite otra corrección si vuelve a ser rechazada/);
  assert.doesNotMatch(html, /type="file"|Guardar fotografía/);
  assert.equal(client.canRespondToPendingIssue(sample, answered), false);
  assert.equal(client.canRespondToPendingIssue(sample, { ...photo, id: "issue-2" }), true);
});

test("la capacidad denegada quita correcciones y muestra el bloqueo sin abrir otras fotos", () => {
  const html = renderEditor(photo, { ...sample, canRespond: false, blockedReason: "La firma está en proceso." });
  assert.match(html, /La firma está en proceso/);
  assert.doesNotMatch(html, /type="file"|Guardar fotografía|<textarea/);
});

test("la novedad general admite comentario y la respuesta registrada se muestra escapada y sin editor", () => {
  const general = { ...photo, key: "GENERAL", label: "Novedad general", evidence: undefined };
  const html = renderEditor(general);
  assert.match(html, /<textarea/); assert.match(html, /maxLength="2000"/);
  assert.match(html, /Guardar respuesta/); assert.doesNotMatch(html, /type="file"|Ampliar/);
  const answered = renderEditor({ ...general, status: "RESPONDED", responseText: "<script>nota</script>" });
  assert.match(answered, /&lt;script&gt;nota&lt;\/script&gt;/); assert.doesNotMatch(answered, /<textarea|Guardar respuesta|<script>/);
});

test("el menú PENDIENTES solo aparece para administradores de aliado externo", () => {
  const roles = load("lib/roles.ts");
  const Sidebar = load("app/dashboard/_components/admin-sidebar.tsx", {
    "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children) },
    "@/app/_components/finser-brand": { default: () => null }, "@/lib/roles": roles,
    "./logout-button": { default: () => null },
  }).default;
  for (const [adminCentral, rolUsuario, expected] of [[false, "ADMIN", true], [true, "ADMIN", false], [false, "VENDEDOR", false], [true, "ANALISTA_APROBACION", false]]) {
    const html = renderToStaticMarkup(React.createElement(Sidebar, { activeHref: "/dashboard/pendientes", adminCentral, rolUsuario, nombreUsuario: "QA" }));
    assert.equal(html.includes('href="/dashboard/pendientes"'), expected);
    if (expected) assert.match(html, /aria-current="page"/);
  }
});

test("la página exige el guard administrativo y rechaza central o ausencia de aliado", async () => {
  for (const [codigo, aliadoId, expected] of [["ALIADO_QA", 9, true], ["FINSERPAY", 1, false], ["ALIADO_QA", null, false]]) {
    let calls = 0;
    const Page = load("app/dashboard/pendientes/page.tsx", {
      "next/navigation": { redirect: (to) => { throw new Error(`redirect:${to}`); } },
      "@/app/_components/finser-ui": ui,
      "@/app/dashboard/_components/admin-sidebar": { default: () => null },
      "@/app/dashboard/_components/admin-workspace-topbar": { default: () => null },
      "@/lib/aliados": { isFinserPayCentralAlly: (value) => value === "FINSERPAY" },
      "@/lib/dashboard-access": { requireAdminDashboardAccess: async () => { calls++; return { session: { nombre: "QA", rolNombre: "ADMIN", aliadoAccesoCodigo: codigo, aliadoAccesoId: aliadoId } }; } },
      "./pending-console": { default: () => React.createElement("div", null, "Pending console") },
    }).default;
    if (expected) assert.match(renderToStaticMarkup(await Page()), /Pending console/);
    else await assert.rejects(Page(), /redirect:\/dashboard/);
    assert.equal(calls, 1);
  }
});
