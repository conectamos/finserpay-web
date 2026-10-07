import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Buffer, Response, Uint8Array,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return loaded.exports;
}

const documents = load("lib/approval-request-document.ts");
const analyst = { id: 17, nombre: "Analista QA", rolNombre: "ANALISTA_APROBACION" };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;
const image = dataUrl("image/png", png);
const pdf = Buffer.from("%PDF-1.7\nfixture\n%%EOF\n");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ nominal = analyst, shared, found = true, value = image, fail = false } = {}) {
  const calls = [];
  const route = load("app/api/aprobaciones/solicitudes/[id]/archivo/[key]/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getNominalApprovalAnalystSessionUser: async () => nominal },
    "@/lib/approval-shared-session": { getApprovalSharedRequestActor: async () => shared },
    "@/lib/approval-request-document": documents,
    "@/lib/solicitudes": { normalizeSolicitudFilters: input => input },
    "@/lib/solicitudes-storage": { getSolicitudDetail: async input => {
      calls.push({ name: "scope", input });
      return found ? { id: "D-7" } : null;
    } },
    "@/lib/prisma": { default: { $queryRawUnsafe: async (sql, ...parameters) => {
      calls.push({ name: "sql", sql, parameters });
      if (fail) throw new Error("PRIVATE-DATABASE-DETAIL");
      assert.match(sql, /^\s*SELECT/);
      assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|CREATE\s+TABLE|ALTER\s+TABLE/i);
      return value === undefined ? [] : [{ value }];
    } } },
  });
  return { route, calls };
}

const request = () => new Request("https://finser.test/api/aprobaciones/solicitudes/D-7/archivo/foto-remision");
const context = (id = "D-7", key = "foto-remision") => ({ params: Promise.resolve({ id, key }) });
function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("vary"), "Cookie");
}

test("los archivos exigen sesión nominal y rechazan enlaces o accesos compartidos antes de leer datos", async () => {
  for (const options of [{ nominal: null }, { nominal: null, shared: { name: "Compartido" } }, { shared: {} }, { shared: null }]) {
    const f = fixture(options);
    const response = await f.route.GET(request(), context());
    assert.equal(response.status, 401);
    assertPrivate(response);
    assert.equal(f.calls.length, 0);
  }
});

test("los IDs y claves fuera de la lista permitida se rechazan antes de consultar el expediente", async () => {
  for (const [id, key] of [
    ["C-7", "foto-remision"], ["D-0", "foto-remision"], ["D-007", "foto-remision"],
    ["D-9007199254740992", "foto-remision"], ["D-7/../C-81", "foto-remision"],
    ["D-7", "constructor"], ["D-7", "__proto__"], ["D-7", "providerPayload"],
    ["D-7", "../foto-remision"], ["D-7", "foto-remision?raw=true"],
  ]) {
    const f = fixture();
    const response = await f.route.GET(request(), context(id, key));
    assert.equal(response.status, 404, `${id}/${key}`);
    assertPrivate(response);
    assert.equal(f.calls.length, 0);
  }
});

test("un expediente inexistente no permite consultar su archivo aunque el ID sea válido", async () => {
  const f = fixture({ found: false });
  const response = await f.route.GET(request(), context());
  assert.equal(response.status, 404);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, "scope");
  assertPrivate(response);
});

test("el documento se consulta con alcance nominal en solo lectura y parámetros de lista permitida", async () => {
  const f = fixture();
  const response = await f.route.GET(request(), context());
  assert.equal(response.status, 200);
  assertPrivate(response);
  const scope = f.calls.find(call => call.name === "scope").input;
  assert.equal(scope.readOnly, true);
  assert.deepEqual(plain(scope.viewer), { kind: "APPROVAL_ANALYST", userId: 17, aliadoId: null, sedeId: null, vendedorId: null });
  const sql = f.calls.find(call => call.name === "sql");
  assert.deepEqual(sql.parameters, [7, "fotoRemisionDataUrl"]);
  assert.doesNotMatch(sql.sql, /SELECT\s+\*|SELECT\s+d\."payload"\s+FROM|providerPayload/i);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), String(png.length));
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="solicitud-7-foto-remision.png"');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(png));
});

test("el archivo firmado selecciona una firma vigente y devuelve solo los bytes del PDF", async () => {
  const f = fixture({ value: pdf.toString("base64") });
  const response = await f.route.GET(request(), context("D-7", "documento-firmado"));
  assert.equal(response.status, 200);
  assertPrivate(response);
  const sql = f.calls.find(call => call.name === "sql");
  assert.match(sql.sql, /"draftId"\s*=\s*\$1/);
  assert.match(sql.sql, /"supersededAt"\s+IS\s+NULL/);
  assert.match(sql.sql, /LIMIT 1/);
  assert.deepEqual(sql.parameters, [7]);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(pdf));
});

test("los archivos corruptos o ausentes fallan cerrados sin revelar errores de almacenamiento", async () => {
  for (const value of [null, "", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "https://external.test/photo.png", dataUrl("image/png", pdf)]) {
    const f = fixture({ value });
    const response = await f.route.GET(request(), context());
    assert.equal(response.status, 404);
    assertPrivate(response);
  }
  const f = fixture({ fail: true });
  const response = await f.route.GET(request(), context());
  assert.equal(response.status, 503);
  assertPrivate(response);
  assert.doesNotMatch(await response.text(), /PRIVATE-DATABASE-DETAIL/);
});

test("la validación de MIME usa la firma binaria y rechaza contenido activo o base64 ambiguo", () => {
  const cases = [
    ["image/png", png, "png"], ["image/jpeg", Buffer.from([255, 216, 255, 224]), "jpg"],
    ["image/webp", Buffer.from("RIFF0000WEBP"), "webp"], ["image/gif", Buffer.from("GIF89a0000"), "gif"],
  ];
  for (const [mime, bytes, extension] of cases) {
    const result = documents.decodeApprovalRequestDocument(dataUrl(mime, bytes), "foto-remision");
    assert.equal(result.contentType, mime);
    assert.equal(result.extension, extension);
    assert.ok(result.bytes.equals(bytes));
  }
  for (const value of [
    dataUrl("image/png", Buffer.from([255, 216, 255])), dataUrl("image/jpeg", png),
    "data:image/png;base64,AAAA=", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=",
  ]) assert.equal(documents.decodeApprovalRequestDocument(value, "foto-remision"), null);
  assert.equal(documents.decodeApprovalRequestDocument(Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]).toString("base64"), "documento-firmado"), null);
  assert.ok(documents.decodeApprovalRequestDocument(pdf.toString("base64").replace(/=+$/, ""), "documento-firmado").bytes.equals(pdf));
  assert.ok(documents.decodeApprovalRequestDocument(dataUrl("application/pdf", pdf), "documento-firmado").bytes.equals(pdf));
});

test("el endpoint de archivos no expone verbos de escritura", () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(fixture().route[method], undefined);
});
