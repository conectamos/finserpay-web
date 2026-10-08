import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url);
const { proxy } = await jiti.import("../proxy.ts");
const request = (path, cookies = "approval_analyst_session=nominal-test-cookie", method = "GET") => new NextRequest(`https://finser.test${path}`, {
  method, headers: { cookie: cookies },
});
const passes = response => response.headers.get("x-middleware-next") === "1";

test("the real Next proxy admits only the exact nominal GET for a positive numeric voice-welcome credit id", () => {
  for (const path of ["/api/creditos/1/bienvenida-voz", "/api/creditos/72/bienvenida-voz", "/api/creditos/9999/bienvenida-voz?view=latest"]) {
    const response = proxy(request(path));
    assert.equal(response.status, 200); assert.equal(passes(response), true, path);
  }
});

test("POST and every other method remain blocked for the new analyst endpoint", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const response = proxy(request("/api/creditos/72/bienvenida-voz", undefined, method));
    assert.equal(response.status, 403, method); assert.equal(passes(response), false);
    assert.deepEqual(await response.json(), { error: "Acceso no autorizado" });
  }
});

test("shared and personal approval-link cookies alone do not gain credit-scoped voice reads", () => {
  for (const cookie of ["approval_shared_session=shared-test", "approval_access_session=personal-link-test",
    "approval_shared_session=shared-test; approval_access_session=personal-link-test", ""]) {
    const response = proxy(request("/api/creditos/72/bienvenida-voz", cookie));
    assert.equal(response.status, 401); assert.equal(passes(response), false);
  }
  assert.equal(passes(proxy(request("/api/aprobaciones", "approval_shared_session=shared-test"))), true);
});

test("invalid ids, extra path segments and all other credit endpoints remain forbidden for nominal analysts", () => {
  for (const path of ["/api/creditos/0/bienvenida-voz", "/api/creditos/01/bienvenida-voz", "/api/creditos/-1/bienvenida-voz",
    "/api/creditos/1.2/bienvenida-voz", "/api/creditos/1e2/bienvenida-voz", "/api/creditos/FC-72/bienvenida-voz",
    "/api/creditos/72/bienvenida-voz/", "/api/creditos/72/bienvenida-voz/resultado", "/api/creditos/72/bienvenida-voz-extra",
    "/api/creditos/72/plan-pagos", "/api/creditos/72/abonos", "/api/creditos/72/command", "/api/creditos/72/documentos",
    "/api/creditos", "/api/creditos/borradores", "/api/creditos/masivos"]) {
    const response = proxy(request(path));
    assert.equal(response.status, 403, path); assert.equal(passes(response), false, path);
  }
});

test("ordinary signed-in sessions retain their existing passage and unauthenticated reads remain blocked", () => {
  assert.equal(passes(proxy(request("/api/creditos/72/bienvenida-voz", "session=regular-test"))), true);
  assert.equal(passes(proxy(request("/api/creditos/72/plan-pagos", "session=regular-test"))), true);
  const response = proxy(request("/api/creditos/72/bienvenida-voz", ""));
  assert.equal(response.status, 401); assert.equal(passes(response), false);
});
