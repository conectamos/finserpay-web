import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const dates = await jiti.import("../lib/colombia-date.ts");
const months = await jiti.import("../lib/dashboard-month.ts");
const compiled = ts.transpileModule(readFileSync(path.join(root,
  "app/dashboard/_lib/ally-dashboard-fpd.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const access = Object.freeze({ userId: 12, central: false, aliadoId: 7, sedeId: null });
const now = new Date("2026-11-13T17:00:00Z");

function fixture({ fail, result } = {}) {
  const calls = []; const logs = []; const module = { exports: {} };
  const store = async (...args) => {
    calls.push(args);
    if (fail) throw fail;
    return result ?? args[2].map(cutDate => ({ cutDate, queriedAt: "2026-11-13T17:00:01Z", earlyRisk: [] }));
  };
  new Function("require", "module", "exports", "console", compiled)(name => {
    if (name === "server-only") return {};
    if (name === "@/lib/colombia-date") return dates;
    if (name === "@/lib/dashboard-month") return months;
    if (name === "@/lib/cut-collection-storage") return { getDirectCutRiskComparison: store };
    throw new Error(`Unexpected dependency; live database forbidden: ${name}`);
  }, module, module.exports, { error: (...args) => logs.push(args) });
  return { ...module.exports, calls, logs };
}

for (const [name, month, instant, expected] of [
  ["mes actual", "2026-11", now, ["2026-11-02", "2026-10-17", "2026-10-02"]],
  ["mes pasado completo", "2026-10", now, ["2026-10-17", "2026-10-02", "2026-09-17"]],
  ["mes futuro limitado a hoy", "2027-02", now, ["2026-11-02", "2026-10-17", "2026-10-02"]],
  ["mes inválido usa mes vigente", "2026-13", now, ["2026-11-02", "2026-10-17", "2026-10-02"]],
  ["cambio de año", "2027-01", new Date("2027-01-01T17:00:00Z"), ["2026-12-17", "2026-12-02", "2026-11-17"]],
  ["02 todavía es día 01 en Bogotá", "2026-11", new Date("2026-11-02T04:59:59Z"), ["2026-10-17", "2026-10-02", "2026-09-17"]],
  ["incluye 02 desde medianoche Bogotá", "2026-11", new Date("2026-11-02T05:00:00Z"), ["2026-11-02", "2026-10-17", "2026-10-02"]],
  ["17 todavía es día 16 en Bogotá", "2026-11", new Date("2026-11-17T04:59:59Z"), ["2026-11-02", "2026-10-17", "2026-10-02"]],
  ["incluye 17 desde medianoche Bogotá", "2026-11", new Date("2026-11-17T05:00:00Z"), ["2026-11-17", "2026-11-02", "2026-10-17"]],
  ["fin de febrero bisiesto", "2024-02", now, ["2024-02-17", "2024-02-02", "2024-01-17"]],
  ["primer mes legal no consulta 1999", "2000-01", now, ["2000-01-17", "2000-01-02"]],
]) {
  test(`tres cortes descendentes: ${name}`, async () => {
    const f = fixture();
    const result = await f.getAllyDashboardFpd({ access, month, now: instant });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.cuts.map(item => item.cutDate), expected);
    assert.equal(f.calls.length, 1, "Una sola consulta para los tres cortes");
    assert.deepEqual(f.calls[0][2], expected);
    assert.equal(f.calls[0][0], access, "Preserva el alcance autenticado");
    const [year, cutMonth, day] = expected[0].split("-").map(Number);
    assert.deepEqual(f.calls[0][1], { day, month: cutMonth, year, aliadoId: 7, sedeId: null, status: "todos" });
    assert.deepEqual(f.logs, []);
  });
}

test("antes del primer corte legal retorna disponible sin consultar el store", async () => {
  const f = fixture();
  assert.deepEqual(await f.getAllyDashboardFpd({ access, month: "2000-01",
    now: new Date("2000-01-01T17:00:00Z") }), { status: "ready", cuts: [] });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.logs, []);
});

test("delega exactamente las cinco métricas sin transformar madurez ni disponibilidad", async () => {
  const result = ["2026-11-02", "2026-10-17", "2026-10-02"].map((cutDate, index) => ({
    cutDate, queriedAt: "2026-11-13T17:00:01Z", earlyRisk: [
      { label: "DPF 3", cases: 2 + index, eligible: 11, pending: 1, unavailable: 3 },
      { label: "DPF 7", cases: 1, eligible: 9, pending: 3, unavailable: 3 },
      { label: "DPF 15", cases: 0, eligible: 0, pending: 12, unavailable: 3 },
      { label: "40/60", cases: 0, eligible: 0, pending: 12, unavailable: 3 },
      { label: "FPD MADURO", cases: 0, eligible: 0, pending: 9, unavailable: 6 },
    ],
  }));
  const before = JSON.stringify(result);
  const f = fixture({ result });
  const data = await f.getAllyDashboardFpd({ access, month: "2026-11", sedeId: 21, now });
  assert.equal(data.cuts, result);
  assert.equal(JSON.stringify(result), before);
  assert.equal(f.calls[0][1].sedeId, 21);
  assert.equal(f.calls[0][1].aliadoId, access.aliadoId);
  assert.equal(f.calls[0][1].status, "todos");
});

test("un alcance limitado a sede permanece limitado aunque no se envíe filtro", async () => {
  const scoped = { ...access, sedeId: 21 };
  const f = fixture();
  assert.equal((await f.getAllyDashboardFpd({ access: scoped, month: "2026-11", now })).status, "ready");
  assert.equal(f.calls[0][0], scoped);
  assert.equal(f.calls[0][1].sedeId, 21);
});

test("rechaza alcances globales, aliados ausentes e identificadores inválidos antes del store", async () => {
  for (const input of [
    { access: null }, { access: { ...access, central: true } },
    { access: { ...access, central: undefined } }, { access: { ...access, aliadoId: null } },
    { access: { ...access, aliadoId: 0 } }, { access: { ...access, aliadoId: "7" } },
    { access: { ...access, userId: 0 } }, { access: { ...access, sedeId: -1 } },
    { sedeId: 0 }, { sedeId: 1.5 }, { sedeId: "21" }, { sedeId: 2_147_483_648 },
    { access: { ...access, sedeId: 21 }, sedeId: 22 }, { now: new Date("invalid") },
  ]) {
    const f = fixture();
    assert.deepEqual(await f.getAllyDashboardFpd({ access, month: "2026-11", now, ...input }),
      { status: "unavailable", cuts: [] });
    assert.equal(f.calls.length, 0);
    assert.equal(f.logs.length, 1);
  }
});

test("una sede ajena se valida en el store y cualquier fallo retorna indisponible sin PII", async () => {
  for (const fail of [Object.assign(new Error("Documento secreto; sede ajena"), { status: 403 }),
    new Error("folio interno; detalle PostgreSQL; conexión privada")]) {
    const f = fixture({ fail });
    assert.deepEqual(await f.getAllyDashboardFpd({ access, month: "2026-11", sedeId: 999, now }),
      { status: "unavailable", cuts: [] });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1].sedeId, 999);
    assert.deepEqual(f.logs, [["[ally-dashboard-fpd] No se pudo consultar el riesgo temprano del panel."]]);
  }
});
