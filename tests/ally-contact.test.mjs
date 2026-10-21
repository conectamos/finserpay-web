import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { ensureAllyContactSchema } from "../scripts/ally-contact-schema.mjs";

const contacts = loadReissueModule("lib/ally-contact.ts");
const { normalizeAllyEmail: email, normalizeAllyWhatsApp: phone } = contacts;

test("contactos ausentes siguen permitidos y correos válidos se normalizan", () => {
  for (const empty of [undefined, null, "", "   "]) {
    assert.equal(email(empty), null);
    assert.equal(phone(empty), null);
  }
  assert.equal(email(" Aliado+pagos@EXAMPLE.COM "), "Aliado+pagos@example.com");
  for (const invalid of [12, {}, "persona", "a@example", "a..b@example.com", ".a@example.com", "a@-example.com", "a@exam..ple.com", "a@example.com,b@example.com", "a@example.com\r\nBcc:bad@example.com", `${"a".repeat(65)}@example.com`]) {
    assert.throws(() => email(invalid), (error) => error.field === "email");
  }
});

test("WhatsApp normaliza celulares colombianos, admite E.164 y rechaza caracteres inyectados", () => {
  for (const input of ["3001234567", "+57 (300) 123-4567", "00573001234567", "573001234567"]) assert.equal(phone(input), "573001234567");
  for (const input of ["+1 202 555 0123", "12025550123"]) assert.equal(phone(input), "12025550123");
  for (const input of ["+44 20 7946 0958", "+507 6000 0000"]) assert.equal(phone(phone(input)), phone(input));
  for (const invalid of [3001234567, {}, "3001234567abc", "+57 300123456", "+57 6011234567", "573001234567\n", "++573001234567", "12345", "0000000000", "+1234567890123456"]) {
    assert.throws(() => phone(invalid), (error) => error.field === "telefonoWhatsapp");
  }
});

function fixture(user = { id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }) {
  const records = [
    { id: 10, nombre: "Aliado Prueba", codigo: "PRUEBA", activo: true, email: "old@example.com", telefonoWhatsapp: "573001234567", sedes: [], createdAt: new Date(), updatedAt: new Date() },
    { id: 20, nombre: "Otro Aliado", codigo: "OTRO", activo: true, email: null, telefonoWhatsapp: null, sedes: [], createdAt: new Date(), updatedAt: new Date() },
  ];
  const writes = [];
  const prisma = {
    aliado: {
      findMany: async ({ where }) => records.filter((record) => !where.aliadoId && (!where.id || record.id === where.id)),
      create: async ({ data }) => { writes.push(data); records.push({ ...records[1], ...data, id: 30 }); },
      update: async ({ where, data }) => { writes.push(data); Object.assign(records.find((record) => record.id === where.id), data); },
    },
  };
  const allies = loadReissueModule("lib/aliados.ts");
  const route = loadReissueModule("app/api/aliados/admin/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/prisma": { default: prisma },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/ally-contact": contacts,
    "@/lib/aliados": { ...allies, ensureAliadoSchema: async () => {}, ensureAliadoFinserPay: async () => {}, ensureAliadoConectamos: async () => {} },
    "@/lib/digital-collection-sede": { ensureDigitalCollectionSede: async () => {} },
  });
  const request = (method, body) => new Request("https://example.test/api/aliados/admin", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { route, request, records, writes };
}

test("crear guarda email y WhatsApp; los devuelve para edición y no envía mensajes", async () => {
  const f = fixture();
  const response = await f.route.POST(f.request("POST", { nombre: "Nuevo", email: "nuevo@EXAMPLE.COM", telefonoWhatsapp: "3009876543" }));
  assert.equal(response.status, 200);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].email, "nuevo@example.com");
  assert.equal(f.writes[0].telefonoWhatsapp, "573009876543");
  const body = await response.json();
  assert.equal(body.aliados.find((row) => row.id === 30).email, "nuevo@example.com");
});

test("editar permite corregir o borrar un contacto sin borrar el canal omitido", async () => {
  const f = fixture();
  assert.equal((await f.route.PATCH(f.request("PATCH", { aliadoId: 10, email: "new@example.com" }))).status, 200);
  assert.equal(f.records[0].email, "new@example.com");
  assert.equal(f.records[0].telefonoWhatsapp, "573001234567");
  assert.equal((await f.route.PATCH(f.request("PATCH", { aliadoId: 10, email: "", telefonoWhatsapp: "" }))).status, 200);
  assert.equal(f.records[0].email, null);
  assert.equal(f.records[0].telefonoWhatsapp, null);
});

test("contactos inválidos no escriben; no autenticado o aliado distinto no puede editar", async () => {
  const f = fixture();
  for (const [method, body] of [["POST", { nombre: "Prueba", email: "bad" }], ["PATCH", { aliadoId: 10, telefonoWhatsapp: "invalid" }]]) {
    assert.equal((await f.route[method](f.request(method, body))).status, 400);
  }
  assert.equal(f.writes.length, 0);
  const scoped = fixture({ id: 4, rolNombre: "ADMIN", aliadoAccesoCodigo: "PRUEBA", aliadoAccesoId: 10 });
  assert.equal((await scoped.route.PATCH(scoped.request("PATCH", { aliadoId: 20, email: "outside@example.com" }))).status, 403);
  assert.equal((await scoped.route.PATCH(scoped.request("PATCH", { aliadoId: 10, email: "mine@example.com" }))).status, 200);
  assert.equal((await fixture(null).route.GET()).status, 401);
  assert.equal((await fixture({ rolNombre: "ADMIN" }).route.GET()).status, 403);
  assert.equal((await fixture({ rolNombre: "VENDEDOR" }).route.GET()).status, 403);
});

test("migración aditiva e idempotente conserva aliados y contactos ya registrados", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "Aliado" (id integer PRIMARY KEY, nombre text); INSERT INTO "Aliado" VALUES (1, 'Existente');`);
    await ensureAllyContactSchema(db);
    assert.deepEqual((await db.query(`SELECT email, "telefonoWhatsapp" FROM "Aliado" WHERE id=1`)).rows, [{ email: null, telefonoWhatsapp: null }]);
    await db.query(`UPDATE "Aliado" SET email=$1, "telefonoWhatsapp"=$2 WHERE id=1`, ["existing@example.com", "573001234567"]);
    await ensureAllyContactSchema(db);
    assert.deepEqual((await db.query(`SELECT id,nombre,email,"telefonoWhatsapp" FROM "Aliado"`)).rows, [{ id: 1, nombre: "Existente", email: "existing@example.com", telefonoWhatsapp: "573001234567" }]);
  } finally { await db.close(); }
});
