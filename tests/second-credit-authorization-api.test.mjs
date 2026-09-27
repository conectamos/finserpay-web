import assert from "node:assert/strict";
import test from "node:test";
import { actor, document, credit, permission, apiHarness, request } from "./second-credit-authorization-fixture.mjs";

const grantBody = {
  documentNumber: document, action: "AUTHORIZE", reason: "Segundo crédito aprobado por administrador central",
  mutationId: "25dc2abd-8d91-48a7-b4fb-2fc42c0a5b40", expectedVersion: 0,
};
async function body(response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

for (const kind of ["search", "write"]) {
  for (const [name, user, status] of [
    ["sin sesión", null, 401],
    ["administrador del aliado", { ...actor, rolNombre: "ADMIN", aliadoAccesoCodigo: "ALLY" }, 403],
    ["vendedor central", { ...actor, rolNombre: "VENDEDOR", aliadoAccesoCodigo: "FINSERPAY" }, 403],
    ["administrador de sede", { ...actor, rolNombre: "ADMIN_SEDE", aliadoAccesoCodigo: "FINSERPAY" }, 403],
    ["analista de aprobación", { ...actor, rolNombre: "ANALISTA_APROBACION", aliadoAccesoCodigo: "FINSERPAY" }, 403],
  ]) {
    test(`${kind}: ${name} no consulta ni autoriza cédulas`, async () => {
      const { route, calls } = apiHarness(kind, { user });
      let reads = 0;
      const forbidden = new Proxy({}, { get() { reads += 1; throw new Error("No leer cuerpo ni URL antes de verificar ADMIN central"); } });
      const result = await body(await route.POST(forbidden), status);
      assert.equal(result.code, "FORBIDDEN");
      assert.equal(reads, 0);
      assert.equal(calls.queries.length, 0);
      assert.equal(calls.executions.length, 0);
      assert.equal(calls.transactions.length, 0);
    });
  }

  test(`${kind}: solo permite POST sin listado de cédulas ni permisos por URL`, () => {
    const { route } = apiHarness(kind);
    assert.equal(typeof route.POST, "function");
    assert.equal(route.GET, undefined);
    assert.equal(route.DELETE, undefined);
    assert.equal(route.dynamic, "force-dynamic");
    assert.equal(route.runtime, "nodejs");
  });

  test(`${kind}: JSON mal formado falla antes de inicializar o escribir almacenamiento`, async () => {
    const { route, calls } = apiHarness(kind);
    const invalid = new Request("https://finserpay.example/api/creditos/autorizaciones-segundo-credito", { method: "POST", body: "{broken" });
    const result = await body(await route.POST(invalid), 400);
    assert.equal(result.code, "INVALID_REQUEST");
    assert.equal(calls.transactions.length, 0);
  });
}

test("buscar consulta exacta por POST, normaliza y muestra permiso junto con créditos vigentes", async () => {
  const { route, calls } = apiHarness("search", { credits: [credit()], authorizations: [permission()] });
  const result = await body(await route.POST(request({ documentNumber: "1.062.402.825" }, "search")));
  assert.equal(result.documento, document);
  assert.equal(result.activeCredits, 1);
  assert.equal(result.canCreate, true);
  assert.equal(result.authorization.reason, permission().reason);
  assert.deepEqual(result.activeFolios, [credit().folio]);
  assert.equal(result.activeCreditIds, undefined);
  assert.ok(calls.queries.every(({ params }) => params.flat().includes(document)));
  assert.equal(calls.executions.some(({ sql }) => /INSERT|UPDATE|DELETE/.test(sql)), false);
});

test("buscar no usa documentos ni estados suministrados en la URL", async () => {
  const { route, calls } = apiHarness("search");
  const invalid = new Request(`https://finserpay.example/api/creditos/autorizaciones-segundo-credito/buscar?documentNumber=${document}`, { method: "POST", body: JSON.stringify({}) });
  const result = await body(await route.POST(invalid), 400);
  assert.equal(result.code, "INVALID_DOCUMENT");
  assert.equal(calls.queries.length, 0);
});

test("autorizar atribuye actor a la sesión y guarda permiso y auditoría en una transacción", async () => {
  const { route, state } = apiHarness("write", { credits: [credit()] });
  const result = await body(await route.POST(request({ ...grantBody, actorUserId: 88, actorName: "Actor falso", active: false })));
  assert.equal(result.authorization.active, true);
  assert.equal(result.authorization.version, 1);
  assert.equal(result.canCreate, true);
  assert.equal(result.idempotent, false);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].actorUserId, actor.id);
  assert.equal(state.events[0].actorName, actor.nombre);
  assert.equal(state.events[0].action, "AUTHORIZE");
  assert.equal(state.credits[0].montoCredito, 1000);
});

test("revocar exige motivo y versión actual; la revocación no cancela los dos créditos existentes", async () => {
  const { route, state } = apiHarness("write", { credits: [credit(1), credit(2)], authorizations: [permission()] });
  const result = await body(await route.POST(request({ ...grantBody, action: "REVOKE", expectedVersion: 1 })));
  assert.equal(result.authorization.active, false);
  assert.equal(result.activeCredits, 2);
  assert.equal(result.canCreate, false);
  assert.equal(state.credits.length, 2);
  assert.equal(state.credits.every((item) => item.montoCredito === 1000), true);
});

for (const [changes, status, code] of [
  [{ reason: "" }, 400, "INVALID_REASON"],
  [{ expectedVersion: undefined }, 400, "INVALID_VERSION"],
  [{ mutationId: "" }, 400, "INVALID_REQUEST_ID"],
  [{ expectedVersion: 1 }, 409, "VERSION_CONFLICT"],
]) {
  test(`autorizar rechaza ${code} sin otorgar permiso`, async () => {
    const { route, state } = apiHarness("write", { credits: [credit()] });
    const result = await body(await route.POST(request({ ...grantBody, ...changes })), status);
    assert.equal(result.code, code);
    assert.equal(state.authorizations.length, 0);
    assert.equal(state.events.length, 0);
  });
}

test("autorizar con dos créditos vigentes devuelve 409 y no ofrece un tercero", async () => {
  const { route, state } = apiHarness("write", { credits: [credit(1), credit(2)] });
  const result = await body(await route.POST(request(grantBody)), 409);
  assert.equal(result.code, "SECOND_CREDIT_LIMIT_REACHED");
  assert.equal(state.authorizations.length, 0);
});

test("reintento de la misma petición no duplica eventos; fallo de auditoría no deja permiso", async () => {
  const successful = apiHarness("write", { credits: [credit()] });
  await body(await successful.route.POST(request(grantBody)));
  const result = await body(await successful.route.POST(request(grantBody)));
  assert.equal(result.idempotent, true);
  assert.equal(successful.state.events.length, 1);
  const failed = apiHarness("write", { auditCount: 0 });
  const failure = await body(await failed.route.POST(request(grantBody)), 503);
  assert.equal(failure.code, "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE");
  assert.equal(failed.state.authorizations.length, 0);
});

test("buscar falla cerrado ante almacenamiento no disponible y no expone documento/error interno", async () => {
  const { route } = apiHarness("search", { queryError: new Error(`private document ${document}`) });
  const result = await body(await route.POST(request({ documentNumber: document }, "search")), 503);
  assert.equal(result.code, "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes(document), false);
});