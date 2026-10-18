import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { cuotaVencidaWhatsAppSchemaStatements } from "../scripts/cuotavencida-whatsapp-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
export const policy = await jiti.import("../lib/cuotavencida-whatsapp-policy.ts");
const dates = await jiti.import("../lib/colombia-date.ts");
export const requestId = "1df2ddc9-b0bb-4148-baa0-050000000001";
export const requestId2 = "1df2ddc9-b0bb-4148-baa0-050000000002";
export const credit = (id = 1, overrides = {}) => ({ id, clienteNombre: "CLIENTE SINTETICO " + id,
  clienteDocumento: String(1000000000 + id), clienteTelefono: String(3000000000 + id),
  estado: "ENTREGABLE", pazYSalvoEmitidoAt: null, planCapitalVigente: null, montoCredito: 300,
  valorCuota: 100, plazoMeses: 3, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17",
  fechaProximoPago: "2026-10-17", abonos: [], ...overrides });
export const env = { DAPTA_CUOTAVENCIDA_ENABLED: "true", DAPTA_CUOTAVENCIDA_WEBHOOK_URL: "https://api.dapta.ai/synthetic-cuotavencida-test" };

export async function fixture(t, { credits = [credit()], enabled = true } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Credito" ("id" integer PRIMARY KEY,"data" jsonb NOT NULL,
    "clienteTelefono" text GENERATED ALWAYS AS ("data"->>'clienteTelefono') STORED)`);
  for (const sql of cuotaVencidaWhatsAppSchemaStatements) await db.exec(sql);
  if (credits.length) {
    const values = credits.flatMap(row => [row.id, JSON.stringify(row)]);
    await db.query('INSERT INTO "Credito" ("id","data") VALUES ' + credits.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2}::jsonb)`).join(","), values);
  }
  let at = new Date("2026-10-18T15:00:00.000Z"), rollback = false, writes = 0, queries = 0, onQuery = null, onRead = null;
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => {
      queries++; const result = await connection.query(sql, values);
      if (onQuery) await onQuery(sql, values);
      return result.rows;
    },
    $executeRawUnsafe: async (sql, ...values) => { queries++; writes++; return (await connection.query(sql, values)).affectedRows; },
    credito: {
      findMany: async ({ where, take }) => {
        queries++;
        return (await connection.query('SELECT "data" FROM "Credito" WHERE "id">$1 ORDER BY "id" LIMIT $2', [where.id.gt, take])).rows.map(row => row.data);
      },
      findUnique: async ({ where }) => {
        queries++; if (onRead) await onRead(where.id);
        return (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]?.data ?? null;
      },
    },
  });
  const database = { ...adapter(db), $transaction: callback => db.transaction(async connection => {
    const result = await callback(adapter(connection));
    if (rollback) { rollback = false; throw new Error("Synthetic batch rollback"); }
    return result;
  }) };
  const loaded = loadReissueModule("lib/cuotavencida-whatsapp-store.ts", {
    "@/lib/prisma": { default: database }, "@/lib/colombia-date": dates, "@/lib/cuotavencida-whatsapp-policy": policy,
  });
  const store = loaded.createCuotaVencidaWhatsAppStore({ database, enabled: () => enabled, now: () => at });
  const dispatcher = loadReissueModule("lib/cuotavencida-whatsapp-dispatch.ts", { "@/lib/cuotavencida-whatsapp-store": loaded, "@/lib/colombia-date": dates }, { AbortSignal, Buffer, process: { env: {} } });
  const events = () => db.query('SELECT * FROM "CuotaVencidaWhatsAppEvent" ORDER BY "createdAt","id"').then(result => result.rows);
  const update = (id, fields) => db.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [id, JSON.stringify(fields)]);
  const create = (overrides = {}) => store.createCuotaVencidaWhatsAppBatch({ requestId, actorId: 51, ...overrides });
  const run = (overrides = {}) => {
    const sent = [];
    const worker = dispatcher.createCuotaVencidaWhatsAppDispatcher({ env, now: () => at,
      claim: store.claimCuotaVencidaWhatsApp, prepare: store.prepareCuotaVencidaWhatsAppDispatch,
      release: store.releaseCuotaVencidaWhatsAppClaim, accepted: store.markCuotaVencidaWhatsAppAccepted,
      failed: store.markCuotaVencidaWhatsAppFailed, unknown: store.markCuotaVencidaWhatsAppUnknown,
      fetcher: async (_url, options) => {
        const body = JSON.parse(options.body); sent.push(body);
        return Response.json({ ok: true, accepted: true, event_id: body.event_id, provider_message_id: "wamid.synthetic_" + body.event_id, code: null });
      }, ...overrides });
    return { sent, worker };
  };
  return { db, store, loaded, dispatcher, create, events, update, run, now: () => at, time: value => { at = new Date(value); },
    advance: ms => { at = new Date(at.getTime() + ms); }, writes: () => writes, queries: () => queries,
    onQuery: callback => { onQuery = callback; }, onRead: callback => { onRead = callback; }, rollback: () => { rollback = true; } };
}
