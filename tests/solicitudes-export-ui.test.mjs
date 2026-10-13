import assert from "node:assert/strict";
import test from "node:test";
import {
  changeExportSelection,
  exportFiltersFromWall,
  visibleExportOptions,
} from "../app/dashboard/solicitudes/solicitudes-export-state.ts";

const wall = {
  desde: "", hasta: "", aliadoId: "", sedeId: "", asesorId: "",
  estado: "", q: "", plataforma: "",
};
const options = {
  aliados: [{ id: 10, nombre: "Aliado A" }, { id: 20, nombre: "Aliado B" }],
  sedes: [
    { id: 101, nombre: "Sede A1", aliadoId: 10 },
    { id: 102, nombre: "Sede A2", aliadoId: 10 },
    { id: 201, nombre: "Sede B1", aliadoId: 20 },
  ],
  vendedores: [
    { id: 1, nombre: "Vendedor A1", sedeIds: [101] },
    { id: 2, nombre: "Vendedor A2", sedeIds: [102] },
    { id: 3, nombre: "Vendedor B", sedeIds: [201] },
    { id: 4, nombre: "Vendedor compartido", sedeIds: [101, 102] },
  ],
};

test("exportación conserva filtros activos, búsqueda y límite de fecha abierto", () => {
  const filters = exportFiltersFromWall({
    ...wall, desde: "2026-10-01", aliadoId: "10", sedeId: "101", asesorId: "1",
    estado: "PROCESO", q: "001234", plataforma: "IPHONE",
  }, new Date("2026-11-01T03:00:00Z"));
  assert.deepEqual(filters, {
    period: "range", month: "2026-10", desde: "2026-10-01", hasta: "",
    aliadoIds: [10], sedeIds: [101], vendedorIds: [1],
    estado: "PROCESO", q: "001234", plataforma: "IPHONE",
  });
});

test("sin periodo en el muro se selecciona todo el histórico y los filtros no se mutan", () => {
  const source = { ...wall };
  const filters = exportFiltersFromWall(source);
  assert.equal(filters.period, "all");
  assert.deepEqual(source, wall);
  assert.deepEqual(visibleExportOptions(options, filters), options);
});

test("selecciones combinadas limitan sedes y vendedores visibles sin duplicar vendedores", () => {
  const filters = { ...exportFiltersFromWall(wall), aliadoIds: [10], sedeIds: [101, 102] };
  const visible = visibleExportOptions(options, filters);
  assert.deepEqual(visible.sedes.map(value => value.id), [101, 102]);
  assert.deepEqual(visible.vendedores.map(value => value.id), [1, 2, 4]);
  assert.deepEqual(visibleExportOptions(options, { ...filters, sedeIds: [102] }).vendedores.map(value => value.id), [2, 4]);
});

test("cambiar aliado o sede retira selecciones dependientes fuera del nuevo alcance", () => {
  const original = { ...exportFiltersFromWall(wall), sedeIds: [101, 201], vendedorIds: [1, 3, 4] };
  const allyChange = changeExportSelection(original, options, "aliadoIds", [10]);
  assert.deepEqual(allyChange.sedeIds, [101]);
  assert.deepEqual(allyChange.vendedorIds, [1, 4]);
  const siteChange = changeExportSelection(allyChange, options, "sedeIds", [102]);
  assert.deepEqual(siteChange.vendedorIds, [4]);
  assert.deepEqual(original.sedeIds, [101, 201]);
  assert.deepEqual(original.vendedorIds, [1, 3, 4]);
});
