import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { normalizeAttentionPhone, parseAttentionMutation, parseAttentionFilters, assertAttentionActor } = await jiti.import("../lib/atencion-core.ts");
const requestId = "10000000-0000-4000-8000-000000000001";
test("teléfonos colombianos coinciden exactamente sin igualar sufijos extranjeros", () => {
  for (const value of ["3001234567", "+57 (300) 123-4567", "00573001234567"]) assert.equal(normalizeAttentionPhone(value), "+573001234567");
  assert.notEqual(normalizeAttentionPhone("+13001234567"), normalizeAttentionPhone("3001234567"));
  for (const value of ["", "300", "a3001234567", "+", 3001234567]) assert.throws(() => normalizeAttentionPhone(value));
});
test("mutaciones exigen UUID, versión, texto y fechas inequívocas", () => {
  const base = { action: "note", text: "Nota real", version: 1, requestId };
  assert.equal(parseAttentionMutation(base).text, "Nota real");
  for (const input of [{ ...base, version: "1" }, { ...base, requestId: "x" }, { ...base, action: "send" }, { ...base, text: " " }, { ...base, action: "task", dueAt: "2026-10-30T10:00" }]) assert.throws(() => parseAttentionMutation(input));
  assert.equal(parseAttentionMutation({ ...base, action: "task", dueAt: "2026-10-30T10:00:00-05:00" }).dueAt, "2026-10-30T15:00:00.000Z");
});
test("filtros y alcance fallan cerrados", () => {
  assert.deepEqual(parseAttentionFilters(new URLSearchParams()), { search: "", filter: "mine", page: 1 });
  for (const text of ["filter=admin", "page=-1", "page=0", "page=1e3", "filter=all&filter=mine", "search=a&search=b"]) assert.throws(() => parseAttentionFilters(new URLSearchParams(text)));
  assert.throws(() => assertAttentionActor({ userId: 1, sellerId: null, key: "user:1", admin: false, central: true, aliadoId: 1, sedeId: 10 }));
});

test("actores requieren identidad explícita central o analista, sin compatibilidad con vendedores", () => {
  const admin={userId:1,sellerId:null,key:"admin:1",central:true,admin:true,analyst:false,supervisor:false};
  const analyst={...admin,key:"analyst:1",central:false,admin:false,analyst:true};
  assert.doesNotThrow(()=>assertAttentionActor(admin)); assert.doesNotThrow(()=>assertAttentionActor(analyst));
  for(const actor of [{...admin,key:"user:1"},{...analyst,key:"seller:1",sellerId:1},{...analyst,supervisor:true},{...analyst,central:true},{...admin,analyst:true}]) assert.throws(()=>assertAttentionActor(actor),{status:403});
  const base={action:"transfer",version:1,requestId};
  assert.equal(parseAttentionMutation({...base,assigneeKey:"analyst:5"}).assigneeKey,"analyst:5");
  for(const assigneeKey of ["user:1","admin:1","seller:1","analyst:0"]) assert.throws(()=>parseAttentionMutation({...base,assigneeKey}));
});
