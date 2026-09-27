import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { load, routeFixture, catalogs, sample, call } from "./mass-credit-sadmin-fixture.mjs";

const { readImportCustomer } = load("lib/mass-credit-customer.ts");
const today = new Date("2026-09-26T17:00:00.000Z");
const customer = changes => ({
  direccion: "Calle 10 #20-30", correo: "cliente@example.test", fechaNacimiento: "1990-01-15",
  sexo: "MASCULINO", ...changes,
});
const errors = changes => readImportCustomer(customer(changes), today).errors.join(" | ");

// Exercise the actual HTTP route and its transaction rather than replace its validation.
function databaseFixture() {
  const state = { credits: [], registrations: [], audits: [], transactions: 0, failNumber: null };
  function adapter(storage) {
    return {
      ...catalogs,
      $queryRawUnsafe: async (sql, ...params) => {
        if (sql.includes('INSERT INTO "CreditSadminRegistration"')) {
          if (state.failNumber === params[1]) throw new Error("Synthetic SADMIN write failed");
          storage.registrations.push({ creditoId: params[0], number: params[1] });
          return [{ creditoId: params[0] }];
        }
        if (sql.includes('AS "requestHash"')) {
          return storage.credits.filter(credit => credit.contratoSnapshot.origen.requestId === params[0]).map(credit => ({
            id: credit.id, folio: credit.folio, row: credit.contratoSnapshot.origen.importReceipt,
            requestHash: credit.contratoSnapshot.origen.requestHash, batchId: credit.contratoSnapshot.origen.batchId,
          }));
        }
        if (sql.includes("AS documento")) {
          return storage.credits.filter(credit => params[0].includes(credit.clienteDocumento))
            .map(credit => ({ documento: credit.clienteDocumento, folio: credit.folio }));
        }
        if (sql.includes("AS numero")) {
          return storage.registrations.filter(registration => params[0].includes(registration.number.toLowerCase()))
            .map(registration => ({ numero: registration.number.toLowerCase() }));
        }
        return [];
      },
      $executeRawUnsafe: async (sql, ...params) => {
        if (sql.includes('INSERT INTO "CreditSadminEvent"')) storage.audits.push({ creditoId: params[1], payload: JSON.parse(params[4]) });
        return 1;
      },
      credito: {
        findMany: async ({ where }) => storage.credits.filter(credit => where.OR[0].imei.in.includes(credit.imei))
          .map(credit => ({ folio: credit.folio, imei: credit.imei, deviceUid: credit.deviceUid })),
        findUnique: async ({ where }) => storage.credits.find(credit => credit.folio === where.folio) ?? null,
        create: async ({ data }) => {
          const credit = { ...data, id: storage.credits.length + 1 };
          storage.credits.push(credit);
          return { id: credit.id, folio: credit.folio };
        },
      },
    };
  }
  const db = adapter(state);
  db.$transaction = async work => {
    state.transactions += 1;
    const staged = { credits: [...state.credits], registrations: [...state.registrations], audits: [...state.audits] };
    const result = await work(adapter(staged));
    state.credits = staged.credits; state.registrations = staged.registrations; state.audits = staged.audits;
    return result;
  };
  return { state, route: routeFixture(db) };
}
const confirmation = () => ({ commit: true, sadminConfirmed: true, requestId: randomUUID() });

function assertCustomerPersisted(credit, expected) {
  assert.equal(credit.clienteDireccion, expected.direccion);
  assert.equal(credit.clienteCorreo, expected.correo);
  assert.equal(credit.clienteFechaNacimiento.toISOString(), `${expected.fechaNacimiento}T12:00:00.000Z`);
  assert.equal(credit.clienteGenero, expected.sexo);
  const snapshot = credit.contratoSnapshot.cliente;
  assert.equal(snapshot.direccion, credit.clienteDireccion);
  assert.equal(snapshot.correo, credit.clienteCorreo);
  assert.equal(snapshot.fechaNacimiento, credit.clienteFechaNacimiento.toISOString());
  assert.equal(snapshot.genero, credit.clienteGenero);
  assert.equal(snapshot.cedula, credit.clienteDocumento);
}

test("customer normalization trims address, lowercases email and preserves real birth date", () => {
  const result = readImportCustomer(customer({ direccion: "  Calle Peña #1-02  ", correo: "  CLIENTE+Credito@Example.Test  ", fechaNacimiento: "15/1/1990", sexo: " mujer " }), today);
  assert.equal(result.errors.length, 0);
  assert.equal(result.direccion, "Calle Peña #1-02");
  assert.equal(result.correo, "cliente+credito@example.test");
  assert.equal(result.fechaNacimiento.toISOString(), "1990-01-15T12:00:00.000Z");
  assert.equal(result.sexo, "FEMENINO");
});

test("all four customer fields are mandatory text and cannot be coerced from numbers or objects", () => {
  for (const missing of [undefined, null, "", "   ", 12345, {}]) {
    const result = readImportCustomer({ direccion: missing, correo: missing, fechaNacimiento: missing, sexo: missing }, today);
    assert.equal(result.errors.length, 4);
    for (const field of ["DIRECCION", "CORREO", "FECHA DE NACIMIENTO", "SEXO"]) {
      assert.ok(result.errors.some(error => error.includes(field) && /obligator/i.test(error)), field);
    }
    assert.equal(result.fechaNacimiento, null);
  }
});

test("address and email reject incomplete, malformed, excessive and control-character values", () => {
  for (const direccion of ["1234", "x".repeat(241), "Calle\n10 #20-30", "Calle\u000010 #20-30"]) {
    assert.match(errors({ direccion }), /DIRECCION/);
  }
  for (const direccion of ["12345", "x".repeat(240)]) assert.equal(errors({ direccion }), "");
  for (const correo of ["cliente", "cliente@ejemplo", "cliente@@example.test", "cliente @example.test", "a\nb@example.test", `${"x".repeat(250)}@example.test`]) {
    assert.match(errors({ correo }), /CORREO/);
  }
});

test("birth date accepts only strict real ISO or Colombian day/month/year, never Excel serials or rollovers", () => {
  for (const fechaNacimiento of ["1990-1-15", "15-01-1990", "01/15/1990", "31/02/1990", "29/02/1991", "1990-02-30", "1990-13-01", "1990-00-01", "1990-01-00", "1990-01-15T00:00:00Z", "32900", 32900, new Date("1990-01-15")]) {
    const result = readImportCustomer(customer({ fechaNacimiento }), today);
    assert.equal(result.fechaNacimiento, null, String(fechaNacimiento));
    assert.match(result.errors.join(" | "), /FECHA DE NACIMIENTO/, String(fechaNacimiento));
  }
  for (const fechaNacimiento of ["2000-02-29", "29/2/2000"]) {
    const result = readImportCustomer(customer({ fechaNacimiento }), today);
    assert.equal(result.errors.length, 0);
    assert.equal(result.fechaNacimiento.toISOString(), "2000-02-29T12:00:00.000Z");
  }
});

test("birth dates require adulthood today and explicitly reject future dates without replacing them", () => {
  assert.equal(errors({ fechaNacimiento: "2008-09-26" }), "");
  assert.match(errors({ fechaNacimiento: "2008-09-27" }), /18 años/);
  assert.match(errors({ fechaNacimiento: "2026-09-26" }), /18 años/);
  const future = readImportCustomer(customer({ fechaNacimiento: "2026-09-27" }), today);
  assert.match(future.errors.join(" | "), /futuro/);
  assert.equal(future.fechaNacimiento.toISOString(), "2026-09-27T12:00:00.000Z");
});

test("the eighteenth birthday changes at Bogotá midnight, not the UTC date boundary", () => {
  const input = customer({ fechaNacimiento: "2008-09-26" });
  assert.match(readImportCustomer(input, new Date("2026-09-26T04:59:59.999Z")).errors.join(" | "), /18 años/);
  assert.equal(readImportCustomer(input, new Date("2026-09-26T05:00:00.000Z")).errors.length, 0);
});

test("sex aliases match the existing customer catalog and unsupported values remain errors", () => {
  for (const [canonical, aliases] of [
    ["MASCULINO", ["M", "masculino", " hombre ", "male"]],
    ["FEMENINO", ["F", "femenino", "mujer", "female"]],
    ["OTRO", ["O", "otro"]],
    ["PREFIERO_NO_DECIR", ["PREFIERO_NO_DECIR", "Prefiero no decir", "prefiero-no-decir", "Prefiero no decirlo"]],
  ]) {
    for (const sexo of aliases) {
      const result = readImportCustomer(customer({ sexo }), today);
      assert.equal(result.errors.length, 0, sexo); assert.equal(result.sexo, canonical, sexo);
    }
  }
  for (const sexo of ["desconocido", "1", "MF"]) assert.match(errors({ sexo }), /SEXO inválido/);
});

test("CSV preview reports row customer errors before import and does not create even valid rows of an invalid batch", async () => {
  const { route, state } = databaseFixture();
  const rows = [sample(1), sample(2, { direccion: "" }), sample(3, { correo: "sin-arroba" }),
    sample(4, { fechaNacimiento: "31/02/1990" }), sample(5, { sexo: "desconocido" }),
    sample(6, { direccion: "", correo: "", fechaNacimiento: "", sexo: "" })];
  const preview = await call(route, rows);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.summary.valid, 1); assert.equal(preview.data.summary.invalid, 5);
  for (const [index, pattern] of [[1, /DIRECCION/], [2, /CORREO/], [3, /FECHA DE NACIMIENTO/], [4, /SEXO/]]) {
    assert.equal(preview.data.rows[index].rowNumber, index + 1);
    assert.match(preview.data.rows[index].errors.join(" | "), pattern);
  }
  assert.equal(preview.data.rows[5].errors.length, 4);
  assert.equal(state.credits.length, 0); assert.equal(state.transactions, 0);
  const commit = await call(route, rows, confirmation());
  assert.equal(commit.data.commit, false); assert.equal(commit.data.summary.invalid, 5);
  assert.equal(state.credits.length, 0); assert.equal(state.registrations.length, 0); assert.equal(state.audits.length, 0);
});

test("single-credit direct commit cannot bypass missing customer fields or invalid birth dates", async () => {
  const { route, state } = databaseFixture();
  const underAge = `${Number(new Intl.DateTimeFormat("en", { timeZone: "America/Bogota", year: "numeric" }).format(new Date())) - 17}-01-01`;
  for (const changes of [{ direccion: "" }, { correo: "" }, { fechaNacimiento: "" }, { sexo: "" },
    { fechaNacimiento: "31/02/1990" }, { fechaNacimiento: underAge }, { fechaNacimiento: "2099-01-01" }]) {
    const result = await call(route, [sample(1, changes)], confirmation());
    assert.equal(result.status, 200); assert.equal(result.data.commit, false); assert.equal(result.data.summary.invalid, 1);
  }
  assert.equal(state.credits.length, 0); assert.equal(state.registrations.length, 0);
});

test("CSV commits canonical customer values on each credit, snapshot and receipt without changing finance or approval", async () => {
  const { route, state } = databaseFixture();
  const rows = [sample(1, { direccion: "  Calle Peña #1-02  ", correo: "  CLIENTE@EXAMPLE.TEST  ", fechaNacimiento: "15/1/1990", sexo: "M" }),
    sample(2, { direccion: "Carrera 8 #9-10", correo: "OTRA@Example.Test", fechaNacimiento: "2000-02-29", sexo: "Prefiero no decir" })];
  const expected = [customer({ direccion: "Calle Peña #1-02", correo: "cliente@example.test" }),
    customer({ direccion: "Carrera 8 #9-10", correo: "otra@example.test", fechaNacimiento: "2000-02-29", sexo: "PREFIERO_NO_DECIR" })];
  const preview = await call(route, rows);
  assert.equal(preview.data.summary.valid, 2);
  const request = confirmation(); const result = await call(route, rows, request);
  assert.equal(result.status, 200); assert.equal(result.data.commit, true); assert.equal(result.data.created, 2);
  assert.equal(state.credits.length, 2); assert.equal(state.registrations.length, 2); assert.equal(state.audits.length, 2);
  state.credits.forEach((credit, index) => {
    assertCustomerPersisted(credit, expected[index]);
    assert.equal(credit.clienteDocumento, rows[index].cedula); assert.equal(credit.imei, rows[index].imei);
    assert.equal(credit.estado, "GENERADO"); assert.equal(credit.deliverableReady, false);
    assert.equal(credit.equalityService, "IMPORTACION_MASIVA");
    assert.equal(credit.montoCredito, Number(rows[index].cuota) * Number(rows[index].plazo));
    assert.equal(credit.saldoBaseFinanciado, Number(rows[index].valorCredito));
    assert.equal(credit.valorCuota, 60000); assert.equal(credit.cuotaInicial, 100000);
    const normalized = result.data.rows[index].normalized;
    for (const field of ["direccion", "correo", "fechaNacimiento", "sexo"]) assert.equal(normalized[field], expected[index][field]);
    assert.equal(credit.contratoSnapshot.origen.importReceipt.normalized.fechaNacimiento, expected[index].fechaNacimiento);
  });
  assert.deepEqual(state.registrations.map(row => row.number), rows.map(row => row.numeroCreditoSadmin));
  const replay = await call(route, rows, request);
  assert.deepEqual(replay.data, result.data); assert.equal(state.credits.length, 2);
  const changed = await call(route, [{ ...rows[0], direccion: "Calle nueva #5-20" }, rows[1]], request);
  assert.equal(changed.status, 409); assert.equal(changed.data.code, "IMPORT_REQUEST_CONFLICT");
  assert.equal(state.credits.length, 2); assert.equal(state.credits[0].clienteDireccion, expected[0].direccion);
});

test("individual creation persists the same canonical customer fields as CSV creation", async () => {
  const { route, state } = databaseFixture();
  const result = await call(route, [sample(7, { direccion: "Carrera 4 #5-6", correo: " INDIVIDUAL@Example.Test ", fechaNacimiento: "2/3/1994", sexo: "O" })], confirmation());
  assert.equal(result.data.commit, true); assert.equal(result.data.created, 1);
  assertCustomerPersisted(state.credits[0], customer({ direccion: "Carrera 4 #5-6", correo: "individual@example.test", fechaNacimiento: "1994-03-02", sexo: "OTRO" }));
  assert.equal(result.data.rows[0].normalized.fechaNacimiento, "1994-03-02");
  assert.equal(state.registrations.length, 1); assert.equal(state.audits.length, 1);
});

test("failed SADMIN persistence rolls back new customer data and a retry creates only the complete batch", async () => {
  const { route, state } = databaseFixture();
  const rows = [sample(11), sample(12, { sexo: "F", fechaNacimiento: "2/3/1994" })];
  const request = confirmation(); state.failNumber = rows[1].numeroCreditoSadmin;
  const failed = await call(route, rows, request);
  assert.equal(failed.status, 500); assert.equal(failed.data.code, "IMPORT_SAVE_FAILED");
  assert.equal(state.credits.length, 0); assert.equal(state.registrations.length, 0); assert.equal(state.audits.length, 0);
  state.failNumber = null;
  const retry = await call(route, rows, request);
  assert.equal(retry.status, 200); assert.equal(retry.data.created, 2);
  assertCustomerPersisted(state.credits[0], customer({ direccion: rows[0].direccion, correo: rows[0].correo }));
  assertCustomerPersisted(state.credits[1], customer({ direccion: rows[1].direccion, correo: rows[1].correo, fechaNacimiento: "1994-03-02", sexo: "FEMENINO" }));
  assert.equal(state.registrations.length, 2); assert.equal(state.audits.length, 2);
});


test("new customer fields do not permit a second credit or modify the profile of an existing document", async () => {
  const { route, state } = databaseFixture();
  const first = sample(21);
  assert.equal((await call(route, [first], confirmation())).data.created, 1);
  const duplicate = sample(22, { cedula: first.cedula, direccion: "Calle nueva #10-30", correo: "nuevo@example.test",
    fechaNacimiento: "1994-03-02", sexo: "FEMENINO" });
  const preview = await call(route, [duplicate]);
  assert.equal(preview.data.summary.invalid, 1);
  assert.match(preview.data.rows[0].errors.join(" | "), /cédula ya tiene un crédito/);
  const result = await call(route, [duplicate], confirmation());
  assert.equal(result.data.commit, false); assert.equal(result.data.summary.invalid, 1);
  assert.equal(state.credits.length, 1); assert.equal(state.registrations.length, 1); assert.equal(state.audits.length, 1);
  assertCustomerPersisted(state.credits[0], customer({ direccion: first.direccion, correo: first.correo }));
});
