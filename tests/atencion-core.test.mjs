import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { normalizeAttentionPhone, parseAttentionMutation, parseAttentionFilters, parseAttentionAgendaFilters, parseAttentionRead, assertAttentionActor } = await jiti.import("../lib/atencion-core.ts");
const requestId = "10000000-0000-4000-8000-000000000001";
test("teléfonos colombianos coinciden exactamente sin igualar sufijos extranjeros", () => {
  for (const value of ["3001234567", "+57 (300) 123-4567", "00573001234567"]) assert.equal(normalizeAttentionPhone(value), "+573001234567");
  assert.notEqual(normalizeAttentionPhone("+13001234567"), normalizeAttentionPhone("3001234567"));
  for (const value of ["", "300", "a3001234567", "+", "++573001234567", "57+3001234567", 3001234567]) assert.throws(() => normalizeAttentionPhone(value));
});

test("filtros operativos y ACK aceptan solo mensajes explícitos y límites acotados",()=>{
  for(const filter of ['unread','unanswered','unassigned'])assert.equal(parseAttentionFilters(new URLSearchParams({filter,tag:'Consulta'})).filter,filter);
  assert.equal(parseAttentionFilters(new URLSearchParams({tag:'ＦＩＮＳＥＲ ＰＡＹ'})).tag,'FINSERPAY');
  assert.throws(()=>parseAttentionFilters(new URLSearchParams('tag=a&tag=b')));
  assert.deepEqual(parseAttentionAgendaFilters(new URLSearchParams()),{filter:'today',page:1});
  for(const query of ['filter=done','filter=today&filter=all','page=0'])assert.throws(()=>parseAttentionAgendaFilters(new URLSearchParams(query)));
  assert.deepEqual(parseAttentionRead({messageIds:[requestId,requestId]}),{messageIds:[requestId]});
  for(const body of [{messageIds:[]},{messageIds:['bad']},{messageIds:Array(501).fill(requestId)},{messageIds:[requestId],readThrough:'now'}])assert.throws(()=>parseAttentionRead(body));
});

test("etiquetas manuales son independientes y FINSERPAY está reservada al servidor", () => {
  const base = { action: "tags", version: 1, requestId };
  assert.deepEqual(parseAttentionMutation({ ...base, tags: [" Prospecto ", "prospecto", "Consulta"] }).tags, ["prospecto", "Consulta"]);
  for (const tag of ["FINSERPAY", "finserpay", "FINSER PAY", "ＦＩＮＳＥＲＰＡＹ", "FINSER\u200bPAY"]) assert.throws(() => parseAttentionMutation({ ...base, tags: [tag] }), { status: 400 });
  assert.throws(() => parseAttentionMutation({ ...base, tags: Array.from({ length: 9 }, (_, i) => `Etiqueta ${i}`) }));
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

test("Clientes es una colección independiente de etiquetas y rechaza parámetros ambiguos", () => {
  assert.deepEqual(parseAttentionFilters(new URLSearchParams("collection=clients&filter=unread&tag=Consulta")),
    { search: "", filter: "unread", page: 1, tag: "Consulta", collection: "clients" });
  for (const query of ["collection=", "collection=all", "collection=welcome", "collection=clients&collection=clients"])
    assert.throws(() => parseAttentionFilters(new URLSearchParams(query)), { status: 400 });
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
