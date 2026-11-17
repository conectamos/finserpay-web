import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { compileFirmaSeguroPortalProbe } from "../scripts/build-firmaseguro-portal-probe.mjs";

const runtimeUrl = new URL("../scripts/verify-firmaseguro-portal-runtime.mjs", import.meta.url);
const runtimeSource = await readFile(runtimeUrl, "utf8");
const driverSource = await readFile(new URL("../lib/firmaseguro-portal.ts", import.meta.url), "utf8");

async function runtimeFixture(options = {}) {
  const state = { loads: 0, accesses: 0, packages: 0, logs: [], errors: [] };
  const process = {
    platform: options.platform ?? "linux", getuid: options.getuid ?? (() => options.uid ?? 1000),
    argv: options.direct ? ["node", fileURLToPath(runtimeUrl)] : [], exitCode: undefined, env: options.env ?? {},
  };
  const code = runtimeSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
    .replaceAll("import.meta.url", JSON.stringify(runtimeUrl.href))
    .replace('await import("./generated/firmaseguro-portal.mjs")', "await loadDriver()");
  const api = await runInNewContext(`(async () => { ${code}\nreturn { verifyFirmaSeguroPortalRuntime }; })()`, {
    process, resolve, pathToFileURL,
    createRequire: () => specifier => {
      state.packages++;
      assert.equal(specifier, "playwright/package.json");
      if (options.packageError) throw options.packageError;
      return { version: options.version ?? "1.65.0" };
    },
    loadDriver: async () => {
      state.loads++;
      if (options.importError) throw options.importError;
      if (options.missingExport) return {};
      return { verifyFirmaSeguroPortalAccess: async () => {
        state.accesses++;
        if (options.accessError) throw options.accessError;
      }, openFirmaSeguroPortalRecipient: () => assert.fail("the runtime probe must never select a recipient") };
    },
    console: { log: value => state.logs.push(value), error: value => state.errors.push(value) },
  });
  return { api, state, process };
}

function rejectCode(code) {
  return error => error.name === "FirmaSeguroPortalRuntimeError" && error.code === code && error.message === code;
}

test("el build conserva el driver real completo y quita únicamente el import server-only antes de transpilar", () => {
  const expected = ts.transpileModule(driverSource.replace(/^import "server-only";\r?\n/, ""), {
    fileName: "firmaseguro-portal.ts",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  }).outputText;
  const generated = compileFirmaSeguroPortalProbe(driverSource);
  assert.equal(generated, expected);
  const ast = ts.createSourceFile("generated.mjs", generated, ts.ScriptTarget.Latest, true);
  const imports = ast.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
  assert.deepEqual(imports, ["playwright"]);
  for (const exportName of ["verifyFirmaSeguroPortalAccess", "openFirmaSeguroPortalRecipient", "FirmaSeguroPortalError"])
    assert.match(generated, new RegExp(`export (?:async )?(?:function|class) ${exportName}\\b`));
});

test("el build conserva otros imports, comentarios y cadenas que mencionan server-only", () => {
  const body = 'import { chromium } from "playwright";\n// server-only remains a comment\nexport const value: string = "server-only";\n';
  const source = '// prefix\nimport "server-only";\n' + body;
  const expected = ts.transpileModule('// prefix\n\n' + body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  assert.equal(compileFirmaSeguroPortalProbe(source), expected);
});

test("el build rechaza un marcador ausente o duplicado y errores de sintaxis", () => {
  assert.throws(() => compileFirmaSeguroPortalProbe("export const valid = true;"), /PORTAL_PROBE_SERVER_MARKER_INVALID/);
  assert.throws(() => compileFirmaSeguroPortalProbe('import "server-only"; import "server-only";'), /PORTAL_PROBE_SERVER_MARKER_INVALID/);
  assert.throws(() => compileFirmaSeguroPortalProbe('import "server-only"; export const broken = ;'), /PORTAL_PROBE_COMPILATION_FAILED/);
});

test("importar la CLI no carga Playwright ni el driver ni inicia acceso", async () => {
  const fixture = await runtimeFixture();
  assert.equal(typeof fixture.api.verifyFirmaSeguroPortalRuntime, "function");
  assert.deepEqual(fixture.state, { loads: 0, accesses: 0, packages: 0, logs: [], errors: [] });
  assert.equal(fixture.process.exitCode, undefined);
});

for (const options of [{ platform: "win32" }, { platform: "darwin" }]) {
  test(`rechaza ${options.platform} antes de cargar o autenticar`, async () => {
    const fixture = await runtimeFixture(options);
    await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), rejectCode("PORTAL_RUNTIME_LINUX_REQUIRED"));
    assert.equal(fixture.state.loads, 0);
    assert.equal(fixture.state.packages, 0);
    assert.equal(fixture.state.accesses, 0);
  });
}

for (const [label, getuid] of [
  ["root", () => 0], ["uid ausente", () => undefined], ["uid inválido", () => -1],
  ["uid fraccional", () => 1.5], ["error del SO", () => { throw new Error("private environment"); }],
]) test(`rechaza ${label} antes de cargar o autenticar`, async () => {
  const fixture = await runtimeFixture({ getuid });
  await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), rejectCode("PORTAL_RUNTIME_NON_ROOT_REQUIRED"));
  assert.equal(fixture.state.loads, 0);
  assert.equal(fixture.state.packages, 0);
  assert.equal(fixture.state.accesses, 0);
});

test("Linux no root usa una sola comprobación del driver y devuelve únicamente metadatos técnicos", async () => {
  const fixture = await runtimeFixture();
  const result = await fixture.api.verifyFirmaSeguroPortalRuntime();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true, code: "PORTAL_RUNTIME_ACCESS_VERIFIED", platform: "linux", uid: 1000, playwrightVersion: "1.65.0", browserTransport: "LOCAL",
  });
  assert.equal(fixture.state.loads, 1);
  assert.equal(fixture.state.accesses, 1);
  assert.equal(fixture.process.exitCode, undefined);
});
test("el recibo distingue el navegador privado sin publicar su token ni endpoint", async () => {
  const env = { FIRMASEGURO_BROWSER_ENDPOINT: "ws://firma-portal-browser.railway.internal:3010/connect",
    FIRMASEGURO_BROWSER_TOKEN: "testtoken_123456789012345678901234567890123" };
  const fixture = await runtimeFixture({ env });
  const result = await fixture.api.verifyFirmaSeguroPortalRuntime();
  assert.equal(result.browserTransport, "PRIVATE");
  assert.equal(fixture.state.accesses, 1);
  assert.equal(JSON.stringify(result).includes(env.FIRMASEGURO_BROWSER_TOKEN), false);
  assert.equal(JSON.stringify(result).includes("railway.internal"), false);
});

for (const options of [{ packageError: new Error("private package path") }, { version: "private data" }]) {
  test("paquete ausente o versión inválida falla sin cargar driver ni exponer datos", async () => {
    const fixture = await runtimeFixture(options);
    await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), rejectCode("PORTAL_RUNTIME_PACKAGE_UNAVAILABLE"));
    assert.equal(fixture.state.loads, 0);
    assert.equal(fixture.state.accesses, 0);
  });
}

for (const options of [{ importError: new Error("private module path") }, { missingExport: true }]) {
  test("driver no empaquetado o contrato ausente falla sin acceso", async () => {
    const fixture = await runtimeFixture(options);
    await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), rejectCode("PORTAL_RUNTIME_DRIVER_UNAVAILABLE"));
    assert.equal(fixture.state.accesses, 0);
  });
}

test("propaga solo códigos de lectura conocidos, sin mensajes ni causes ni retry", async () => {
  const fixture = await runtimeFixture({ accessError: {
    name: "FirmaSeguroPortalError", code: "PORTAL_NAVIGATION_BLOCKED", message: "secret credentials and customer data",
    cause: new Error("secret URL"), stack: "secret stack",
  } });
  await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), error => {
    assert.equal(rejectCode("PORTAL_NAVIGATION_BLOCKED")(error), true);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /secret|credentials|customer/);
    return true;
  });
  assert.equal(fixture.state.accesses, 1);
});

test("conserva exclusivamente fases y categorías enumeradas de un error de lectura conocido", async () => {
  const phases = ["BROWSER_LAUNCH", "CONTEXT", "FIRST_NAVIGATION", "LOGIN_EMAIL", "LOGIN_PASSWORD", "LIST_VERIFICATION"];
  const categories = ["SANDBOX", "BINARY", "DEPENDENCY", "FILESYSTEM", "OTHER"];
  for (const readPhase of phases) for (const runtimeCategory of categories) {
    const fixture = await runtimeFixture({ accessError: {
      name: "FirmaSeguroPortalError", code: "PORTAL_UNAVAILABLE", readPhase, runtimeCategory,
      message: "private credentials", cause: new Error("private URL"), url: "https://private.example.test",
    } });
    await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), error => {
      assert.equal(rejectCode("PORTAL_UNAVAILABLE")(error), true);
      assert.equal(error.readPhase, readPhase);
      assert.equal(error.runtimeCategory, runtimeCategory);
      assert.deepEqual(Object.keys(error).sort(), ["code", "name", "readPhase", "runtimeCategory"]);
      assert.doesNotMatch(error.stack, /private|credentials|example\.test/);
      return true;
    });
    assert.equal(fixture.state.accesses, 1);
  }
});

test("CLI omite fases y categorías desconocidas o con datos privados sin perder el código", async () => {
  for (const diagnostics of [
    { readPhase: "LOGIN_PASSWORD private@example.test", runtimeCategory: "SANDBOX password=private" },
    { readPhase: "https://private.example.test", runtimeCategory: "DATABASE_URL=private" },
    { readPhase: "UNKNOWN", runtimeCategory: "UNKNOWN" },
    { readPhase: "login_email", runtimeCategory: "sandbox" },
    { readPhase: " LOGIN_EMAIL ", runtimeCategory: " SANDBOX " },
    { readPhase: ["LOGIN_EMAIL"], runtimeCategory: { value: "SANDBOX" } },
    { readPhase: null, runtimeCategory: 1 },
  ]) {
    const fixture = await runtimeFixture({ direct: true, accessError: {
      name: "FirmaSeguroPortalError", code: "PORTAL_UNAVAILABLE", ...diagnostics,
      message: "private raw message", stack: "private stack", env: "private environment",
    } });
    assert.deepEqual(fixture.state.errors.map(JSON.parse), [{ ok: false, code: "PORTAL_UNAVAILABLE" }]);
    assert.equal(fixture.process.exitCode, 1);
    assert.equal(fixture.state.accesses, 1);
  }
});

test("CLI incluye cada diagnóstico opcional válido sin copiar el resto del error", async () => {
  for (const [diagnostics, expected] of [
    [{ readPhase: "FIRST_NAVIGATION", runtimeCategory: "DEPENDENCY" }, { readPhase: "FIRST_NAVIGATION", runtimeCategory: "DEPENDENCY" }],
    [{ readPhase: "LOGIN_EMAIL" }, { readPhase: "LOGIN_EMAIL" }],
    [{ runtimeCategory: "OTHER" }, { runtimeCategory: "OTHER" }],
    [{ readPhase: "private@example.test", runtimeCategory: "FILESYSTEM" }, { runtimeCategory: "FILESYSTEM" }],
    [{ readPhase: "CONTEXT", runtimeCategory: "private path" }, { readPhase: "CONTEXT" }],
  ]) {
    const fixture = await runtimeFixture({ direct: true, accessError: {
      name: "FirmaSeguroPortalError", code: "PORTAL_UNAVAILABLE", ...diagnostics,
      message: "password=private", url: "https://private.example.test", env: "private environment",
    } });
    assert.deepEqual(fixture.state.errors.map(JSON.parse), [{ ok: false, code: "PORTAL_UNAVAILABLE", ...expected }]);
    assert.equal(fixture.process.exitCode, 1);
    assert.deepEqual(fixture.state.logs, []);
  }
});

test("errores de otro nombre o código no pueden publicar diagnósticos aunque sus enums sean válidos", async () => {
  for (const identity of [
    { name: "Error", code: "PORTAL_UNAVAILABLE" },
    { name: "FirmaSeguroPortalError", code: "PORTAL_RESULT_UNCERTAIN" },
    { name: "FirmaSeguroPortalError", code: "private code" },
  ]) {
    const fixture = await runtimeFixture({ direct: true, accessError: {
      ...identity, readPhase: "BROWSER_LAUNCH", runtimeCategory: "SANDBOX", message: "private error",
    } });
    assert.deepEqual(fixture.state.errors.map(JSON.parse), [{ ok: false, code: "PORTAL_RUNTIME_ACCESS_FAILED" }]);
    assert.equal(fixture.process.exitCode, 1);
    assert.equal(fixture.state.accesses, 1);
  }
});

for (const accessError of [new Error("secret raw error"),
  { name: "FirmaSeguroPortalError", code: "private value", message: "secret" },
  { name: "FirmaSeguroPortalError", code: "PORTAL_RESULT_UNCERTAIN", message: "secret" },
]) test("fallos desconocidos producen código estable y no se reintentan", async () => {
  const fixture = await runtimeFixture({ accessError });
  await assert.rejects(fixture.api.verifyFirmaSeguroPortalRuntime(), rejectCode("PORTAL_RUNTIME_ACCESS_FAILED"));
  assert.equal(fixture.state.accesses, 1);
});

test("CLI directa publica éxito solo después del acceso, con plataforma uid y versión", async () => {
  const fixture = await runtimeFixture({ direct: true });
  assert.equal(fixture.state.accesses, 1);
  assert.equal(fixture.state.logs.length, 1);
  assert.equal(JSON.parse(fixture.state.logs[0]).code, "PORTAL_RUNTIME_ACCESS_VERIFIED");
  assert.deepEqual(fixture.state.errors, []);
  assert.equal(fixture.process.exitCode, undefined);
});

test("CLI directa falla con exit 1 y JSON estable sin exponer datos", async () => {
  const fixture = await runtimeFixture({ direct: true, accessError: new Error("password=secret customer=private") });
  assert.equal(fixture.process.exitCode, 1);
  assert.deepEqual(fixture.state.logs, []);
  assert.deepEqual(fixture.state.errors.map(JSON.parse), [{ ok: false, code: "PORTAL_RUNTIME_ACCESS_FAILED" }]);
  assert.equal(fixture.state.accesses, 1);
});

test("CLI directa bloquea root sin autenticar y no imprime entorno", async () => {
  const fixture = await runtimeFixture({ direct: true, uid: 0 });
  assert.equal(fixture.process.exitCode, 1);
  assert.equal(fixture.state.accesses, 0);
  assert.deepEqual(fixture.state.errors.map(JSON.parse), [{ ok: false, code: "PORTAL_RUNTIME_NON_ROOT_REQUIRED" }]);
});
