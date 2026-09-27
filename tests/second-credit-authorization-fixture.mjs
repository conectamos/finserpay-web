import assert from "node:assert/strict";
import { load } from "./mass-credit-sadmin-fixture.mjs";

export const core = load("lib/second-credit-authorization-core.ts");
export const creditFactory = load("lib/credit-factory.ts");
export const actor = { id: 19, nombre: "Administrador central sintético" };
export const document = "1062402825";
export const credit = (id = 1, changes = {}) => ({
  id, folio: `FC-TEST-${id}`, documento: document, montoCredito: 1000, cuotaInicial: 100,
  totalAbonado: 0, abonosCount: 0, ...changes,
});
export const permission = (changes = {}) => ({
  id: "94a72510-e929-4c3f-ac56-fd6be690e96f", documento: document, active: true, version: 1,
  reason: "Segundo crédito autorizado tras revisión central", createdAt: "2026-09-27T12:00:00.000Z",
  updatedAt: "2026-09-27T12:00:00.000Z", createdByName: actor.nombre, updatedByName: actor.nombre,
  ...changes,
});
export function mutation(changes = {}) {
  return core.parseSecondCreditMutation({
    documentNumber: document, action: "AUTHORIZE", reason: "Segundo crédito autorizado tras revisión central",
    mutationId: "d1d2eaf0-2894-47fb-97c8-adfbc0d4a752", expectedVersion: 0, ...changes,
  });
}
export function loadStore(prisma = {}, schema = []) {
  return load("lib/second-credit-authorization.ts", {
    "@/lib/prisma": { __esModule: true, default: prisma },
    "@/lib/second-credit-authorization-core": core,
    "@/lib/credit-factory": creditFactory,
    "../scripts/second-credit-authorization-schema.mjs": { secondCreditAuthorizationSchemaStatements: schema },
  });
}
export const store = loadStore();
export function database(options = {}) {
  const calls = { queries: [], executions: [], transactions: [] };
  const state = { authorizations: options.authorizations ?? [], credits: options.credits ?? [], events: [] };
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      calls.queries.push({ sql, params });
      if (options.queryError) throw options.queryError;
      if (sql.includes('FROM public."SecondCreditAuthorizationEvent"')) {
        return state.events.filter((event) => event.mutationId === params[0]);
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM public."SecondCreditAuthorization"')) {
        const documents = Array.isArray(params[0]) ? params[0] : [params[0]];
        return state.authorizations.filter((item) => documents.includes(item.documento));
      }
      if (sql.includes('FROM public."Credito"')) return state.credits.filter((item) => params[0].includes(item.documento));
      if (sql.startsWith('INSERT INTO public."SecondCreditAuthorization"')) {
        const [id, documento, active, reason, actorId, actorName] = params;
        assert.equal(actorId, actor.id);
        const item = permission({ id, documento, active, reason, createdByName: actorName, updatedByName: actorName });
        state.authorizations.push(item);
        return [item];
      }
      if (sql.startsWith('UPDATE public."SecondCreditAuthorization"')) {
        const [id, active, reason, actorId, actorName] = params;
        assert.equal(actorId, actor.id);
        const previous = state.authorizations.find((item) => item.id === id);
        const item = { ...previous, active, reason, version: previous.version + 1, updatedByName: actorName };
        state.authorizations = state.authorizations.map((existing) => existing.id === id ? item : existing);
        return [item];
      }
      throw new Error(`Unexpected SQL in isolated mock: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...params) {
      calls.executions.push({ sql, params });
      if (sql.includes('INSERT INTO public."SecondCreditAuthorizationEvent"')) {
        if (options.auditError) throw options.auditError;
        if (options.auditCount !== undefined && options.auditCount !== 1) return options.auditCount;
        const [id, authorizationId, mutationId, requestHash, action, reason, actorUserId, actorName, before, after] = params;
        state.events.push({ id, authorizationId, mutationId, requestHash, action, reason, actorUserId, actorName, before, after });
        return 1;
      }
      if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('SET LOCAL')) return 1;
      throw new Error(`Unexpected write in isolated mock: ${sql}`);
    },
    async $transaction(callback, settings) {
      calls.transactions.push(settings);
      const backup = structuredClone(state);
      try { return await callback(db); } catch (error) {
        Object.assign(state, backup);
        throw error;
      }
    },
  };
  return { db, state, calls };
}
export function apiHarness(kind, options = {}) {
  const { db, state, calls } = database(options);
  const helper = loadStore(db);
  // Exercise the actual central-role access helper, instead of a route-only permission mock.
  const roles = load("lib/roles.ts");
  const access = load("lib/datacredito/admin-access.ts", {
    "@/lib/auth": { getSessionUser: async () => options.user === undefined
      ? { ...actor, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" } : options.user },
    "@/lib/roles": roles,
    "@/lib/aliados": { isFinserPayCentralAlly: (code) => String(code ?? "").trim().toUpperCase() === "FINSERPAY" },
  });
  const route = load(`app/api/creditos/autorizaciones-segundo-credito/${kind === "search" ? "buscar/" : ""}route.ts`, {
    "next/server": { NextResponse: Response },
    "@/lib/datacredito/admin-access": access,
    "@/lib/prisma": { __esModule: true, default: db },
    "@/lib/second-credit-authorization": helper,
  });
  return { db, state, calls, route };
}
export function request(body, kind = "write") {
  return new Request(`https://finserpay.example/api/creditos/autorizaciones-segundo-credito/${kind === "search" ? "buscar" : ""}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}