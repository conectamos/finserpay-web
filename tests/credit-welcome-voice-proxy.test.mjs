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

const nominal = "approval_analyst_session=nominal-test-cookie";
const dual = "session=regular-test; approval_analyst_session=nominal-test-cookie";
for (const [sessionName, cookie] of [["nominal", nominal], ["regular plus nominal", dual]]) {
  for (const method of ["GET", "POST"]) {
    test(`the real Next proxy admits exact ${method} welcome routes for ${sessionName} sessions`, () => {
      for (const path of ["/api/creditos/1/bienvenida-voz", "/api/creditos/72/bienvenida-voz", "/api/creditos/9999/bienvenida-voz?view=latest"]) {
        const response = proxy(request(path, cookie, method));
        assert.equal(response.status, 200); assert.equal(passes(response), true, path);
      }
    });
  }
}

test("PUT, PATCH, DELETE and other methods remain blocked for nominal and dual sessions", async () => {
  for (const cookie of [nominal, dual]) {
    for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = proxy(request("/api/creditos/72/bienvenida-voz", cookie, method));
      assert.equal(response.status, 403, method); assert.equal(passes(response), false);
      assert.deepEqual(await response.json(), { error: "Acceso no autorizado" });
    }
  }
});

test("shared and personal approval-link cookies alone do not gain GET or POST welcome access", () => {
  for (const cookie of ["approval_shared_session=shared-test", "approval_access_session=personal-link-test",
    "approval_shared_session=shared-test; approval_access_session=personal-link-test"]) {
    for (const method of ["GET", "POST"]) {
      const response = proxy(request("/api/creditos/72/bienvenida-voz", cookie, method));
      assert.equal(response.status, 401); assert.equal(passes(response), false);
    }
  }
  assert.equal(passes(proxy(request("/api/aprobaciones", "approval_shared_session=shared-test"))), true);
});

test("invalid ids and extra path segments remain forbidden for both welcome methods", () => {
  for (const path of ["/api/creditos/0/bienvenida-voz", "/api/creditos/01/bienvenida-voz", "/api/creditos/-1/bienvenida-voz",
    "/api/creditos/1.2/bienvenida-voz", "/api/creditos/1e2/bienvenida-voz", "/api/creditos/FC-72/bienvenida-voz",
    "/api/creditos/72/bienvenida-voz/", "/api/creditos/72/bienvenida-voz/resultado", "/api/creditos/72/bienvenida-voz-extra"]) {
    for (const method of ["GET", "POST"]) {
      const response = proxy(request(path, nominal, method));
      assert.equal(response.status, 403, path); assert.equal(passes(response), false, path);
    }
  }
});

test("other credit endpoints remain forbidden for nominal and dual sessions", () => {
  for (const path of ["/api/creditos/72/plan-pagos", "/api/creditos/72/abonos", "/api/creditos/72/command", "/api/creditos/72/documentos",
    "/api/creditos", "/api/creditos/borradores", "/api/creditos/masivos"]) {
    for (const cookie of [nominal, dual]) {
      for (const method of ["GET", "POST"]) {
        const response = proxy(request(path, cookie, method));
        assert.equal(response.status, 403, path); assert.equal(passes(response), false, path);
      }
    }
  }
});

test("ordinary signed-in sessions retain their existing GET and POST passage", () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(passes(proxy(request("/api/creditos/72/bienvenida-voz", "session=regular-test", method))), true);
    assert.equal(passes(proxy(request("/api/creditos/72/plan-pagos", "session=regular-test", method))), true);
  }
});

test("unauthenticated GET and POST welcome requests remain blocked", () => {
  for (const method of ["GET", "POST"]) {
    const response = proxy(request("/api/creditos/72/bienvenida-voz", "", method));
    assert.equal(response.status, 401); assert.equal(passes(response), false);
  }
});
