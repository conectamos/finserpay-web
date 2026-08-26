import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canSeeSensitiveSolicitudData,
  canViewSolicitud,
  getSolicitudActions,
  isSolicitudExpired,
  normalizeSolicitudFilters,
  resolveSolicitudDeliveryStage,
  resolveSolicitudStage,
} from "../lib/solicitudes.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

const centralAdmin = {
  kind: "CENTRAL_ADMIN",
  userId: 1,
  aliadoId: 1,
  sedeId: null,
  vendedorId: null,
};
const allyAdmin = {
  kind: "ALLY_ADMIN",
  userId: 2,
  aliadoId: 10,
  sedeId: 101,
  vendedorId: null,
};
const supervisor = {
  kind: "SUPERVISOR",
  userId: 3,
  aliadoId: 10,
  sedeId: 101,
  vendedorId: 300,
};
const seller = {
  kind: "SELLER",
  userId: 4,
  aliadoId: 10,
  sedeId: 101,
  vendedorId: 401,
};
const ownSolicitud = {
  aliadoId: 10,
  sedeId: 101,
  vendedorId: 401,
  usuarioId: 4,
};

test("normaliza filtros, limita paginacion y descarta valores invalidos", () => {
  const filters = normalizeSolicitudFilters({
    q: "  Ana\n   Pérez  ",
    desde: "2026-08-01",
    hasta: "2026-02-29",
    aliadoId: "10",
    sedeId: "0",
    asesorId: "401",
    plataforma: " iphone ",
    estado: " validacion_facial ",
    page: "999999",
    pageSize: "500",
    id: " draft:12 ",
  });

  assert.deepEqual(filters, {
    q: "Ana Pérez",
    desde: "2026-08-01",
    hasta: "",
    aliadoId: 10,
    sedeId: null,
    asesorId: 401,
    plataforma: "IPHONE",
    estado: "VALIDACION_FACIAL",
    page: 10_000,
    pageSize: 100,
    id: "draft:12",
  });
  assert.equal(normalizeSolicitudFilters({ estado: "INVENTADO" }).estado, "");
});

test("acepta URLSearchParams y valida fechas calendario reales", () => {
  const query = new URLSearchParams({
    q: "1110508726",
    desde: "2028-02-29",
    hasta: "2028-08-25",
    page: "2",
    pageSize: "50",
  });

  assert.deepEqual(normalizeSolicitudFilters(query), {
    q: "1110508726",
    desde: "2028-02-29",
    hasta: "2028-08-25",
    aliadoId: null,
    sedeId: null,
    asesorId: null,
    plataforma: "",
    estado: "",
    page: 2,
    pageSize: 50,
    id: "",
  });
});

test("aplica alcance central, de aliado, de sede y de asesor", () => {
  const anotherAlly = { ...ownSolicitud, aliadoId: 20 };
  const anotherSite = { ...ownSolicitud, sedeId: 102 };
  const anotherSeller = { ...ownSolicitud, vendedorId: 402 };

  assert.equal(canViewSolicitud(centralAdmin, anotherAlly), true);
  assert.equal(canViewSolicitud(allyAdmin, ownSolicitud), true);
  assert.equal(canViewSolicitud(allyAdmin, anotherSite), true);
  assert.equal(canViewSolicitud(allyAdmin, anotherAlly), false);
  assert.equal(canViewSolicitud(supervisor, ownSolicitud), true);
  assert.equal(canViewSolicitud(supervisor, anotherSeller), true);
  assert.equal(canViewSolicitud(supervisor, anotherSite), false);
  assert.equal(canViewSolicitud(supervisor, anotherAlly), false);
  assert.equal(canViewSolicitud(seller, ownSolicitud), true);
  assert.equal(canViewSolicitud(seller, anotherSeller), false);
  assert.equal(canViewSolicitud(seller, anotherSite), false);
  assert.equal(canViewSolicitud(seller, anotherAlly), false);
});

test("datos sensibles quedan restringidos a administradores", () => {
  assert.equal(canSeeSensitiveSolicitudData(centralAdmin), true);
  assert.equal(canSeeSensitiveSolicitudData(allyAdmin), true);
  assert.equal(canSeeSensitiveSolicitudData(supervisor), false);
  assert.equal(canSeeSensitiveSolicitudData(seller), false);
});

test("deriva etapas usando los estados reales de los subsistemas", () => {
  const cases = [
    [{ source: "DRAFT", draftState: "ABIERTO" }, "CONSULTA_PENDIENTE"],
    [{ source: "DRAFT", dataCreditoStatus: "PENDING" }, "CONSULTA_PENDIENTE"],
    [{ source: "DRAFT", dataCreditoStatus: "APROBADO" }, "APROBADA"],
    [{ source: "DRAFT", dataCreditoStatus: "RECHAZADO" }, "RECHAZADA"],
    [
      { source: "DRAFT", dataCreditoStatus: "APROBADO", veriffStatus: "REVIEW" },
      "VALIDACION_FACIAL",
    ],
    [
      {
        source: "DRAFT",
        dataCreditoStatus: "APROBADO",
        veriffStatus: "APPROVED",
        currentStep: 4,
      },
      "CONTRATOS",
    ],
    [
      {
        source: "DRAFT",
        dataCreditoStatus: "APROBADO",
        veriffStatus: "APPROVED",
        firmaStatus: "SIGNED",
      },
      "LISTA_PARA_ENTREGA",
    ],
    [
      {
        source: "DRAFT",
        dataCreditoStatus: "NO_EVALUADO",
        dataCreditoErrorCode: "PROVIDER_TIMEOUT",
      },
      "ERROR_TECNICO",
    ],
    [
      { source: "DRAFT", draftState: "CERRADO", closedReason: "DESISTIDA" },
      "CANCELADA",
    ],
    [
      {
        source: "DRAFT",
        draftState: "CERRADO",
        closedReason: "EXPIRADA_15_DIAS",
      },
      "CANCELADA",
    ],
    [{ source: "CREDIT", creditState: "ENTREGABLE" }, "APROBADA"],
    [{ source: "CREDIT", creditState: "ANULADO" }, "CANCELADA"],
  ];

  for (const [signals, expected] of cases) {
    assert.equal(resolveSolicitudStage(signals), expected);
  }
});

test("mantiene APROBADA como estado comercial y entrega como etapa operativa", () => {
  assert.equal(
    resolveSolicitudStage({ source: "CREDIT", creditState: "ENTREGABLE" }),
    "APROBADA"
  );
  assert.equal(
    resolveSolicitudDeliveryStage({ creditState: "ENTREGABLE", deliverableReady: true }),
    "LISTA_PARA_ENTREGA"
  );
  assert.equal(
    resolveSolicitudDeliveryStage({ creditState: "ENTREGABLE", hasDeliveryEvidence: true }),
    "ENTREGADA"
  );
});

test("expira exactamente al cumplir 15 dias calendario", () => {
  const createdAt = "2026-08-01T15:30:00.000Z";
  assert.equal(isSolicitudExpired(createdAt, "2026-08-16T15:29:59.999Z"), false);
  assert.equal(isSolicitudExpired(createdAt, "2026-08-16T15:30:00.000Z"), true);
  assert.equal(isSolicitudExpired("fecha-invalida", new Date()), false);
});

test("la fabrica del borrador respeta central, aliado, sede y asesor titular", () => {
  const openDraft = {
    ownership: ownSolicitud,
    source: "DRAFT",
    state: "APROBADA",
    draftState: "ABIERTO",
  };
  assert.deepEqual(getSolicitudActions({ viewer: seller, ...openDraft }), [
    "VER_DETALLE",
    "ABRIR_FABRICA",
    "DESISTIR",
  ]);
  assert.deepEqual(getSolicitudActions({ viewer: supervisor, ...openDraft }), [
    "VER_DETALLE",
  ]);
  assert.deepEqual(getSolicitudActions({ viewer: allyAdmin, ...openDraft }), [
    "VER_DETALLE",
  ]);
  assert.deepEqual(getSolicitudActions({ viewer: centralAdmin, ...openDraft }), [
    "VER_DETALLE",
    "ABRIR_FABRICA",
  ]);
  assert.deepEqual(
    getSolicitudActions({ viewer: { ...seller, vendedorId: 402 }, ...openDraft }),
    []
  );
  assert.deepEqual(
    getSolicitudActions({
      viewer: seller,
      ...openDraft,
      state: "CANCELADA",
      draftState: "CERRADO",
    }),
    ["VER_DETALLE"]
  );
});

test("solo central abre en fabrica un credito aprobado", () => {
  assert.deepEqual(
    getSolicitudActions({
      viewer: centralAdmin,
      ownership: ownSolicitud,
      source: "CREDIT",
      state: "APROBADA",
    }),
    ["VER_DETALLE", "ABRIR_FABRICA"]
  );
  for (const viewer of [allyAdmin, supervisor, seller]) {
    assert.deepEqual(
      getSolicitudActions({
        viewer,
        ownership: ownSolicitud,
        source: "CREDIT",
        state: "APROBADA",
      }),
      ["VER_DETALLE"]
    );
  }
  assert.deepEqual(
    getSolicitudActions({
      viewer: centralAdmin,
      ownership: ownSolicitud,
      source: "CREDIT",
      state: "CANCELADA",
    }),
    ["VER_DETALLE"]
  );
});

test("el endpoint aplica sesion, alcance y no permite eliminaciones", async () => {
  const route = await readProjectFile("app/api/solicitudes/route.ts");
  assert.match(route, /getSessionUser|getDashboardSession|requireDashboardSession/);
  assert.match(route, /normalizeSolicitudFilters/);
  assert.match(route, /viewer|SolicitudViewer/);
  assert.match(route, /Cache-Control[\s\S]{0,100}no-store|no-store[\s\S]{0,100}Cache-Control/i);
  assert.match(route, /DESISTIR/);
  assert.doesNotMatch(route, /export\s+async\s+function\s+DELETE/);
});

test("consultar el muro nunca dispara una consulta a DataCredito", async () => {
  const [route, storage, ui] = await Promise.all([
    readProjectFile("app/api/solicitudes/route.ts"),
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  ]);
  const wallSources = `${route}\n${storage}\n${ui}`;
  assert.doesNotMatch(wallSources, /queryDataCreditoNaturalPerson/);
  assert.doesNotMatch(
    wallSources,
    /\/api\/creditos\/datacredito\/evaluaciones(?:["'/?]|$)/
  );
  assert.doesNotMatch(wallSources, /providerPayload|secureRecord/);
});

test("el muro muestra y ordena por la fecha de creación original", async () => {
  const [storage, ui] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  ]);
  const listSection = ui.slice(
    ui.indexOf("<thead"),
    ui.indexOf('aria-labelledby="solicitud-detail-title"')
  );

  assert.equal(
    [...listSection.matchAll(/Fecha de creación/g)].length,
    2,
    "debe rotular la fecha de creación en escritorio y celular"
  );
  assert.match(listSection, /item\.createdAt \|\| item\.fechaCreacion/);
  assert.doesNotMatch(listSection, /item\.updatedAt \|\| item\.fechaActualizacion/);
  assert.match(ui, /Última actualización/);

  assert.match(storage, /createdAtExpression: string/);
  assert.match(
    storage,
    /createdAtExpression: `d\."createdAt"`[\s\S]*createdAtExpression: createdAt/
  );
  assert.match(
    storage,
    /SELECT MIN\(draft\."createdAt"\) AS "createdAt"[\s\S]*draft\."creditoId" = c\."id"/
  );
  assert.match(
    storage,
    /String\(right\.createdAt \|\| ""\)\.localeCompare\(String\(left\.createdAt \|\| ""\)\)/
  );
  assert.doesNotMatch(
    storage,
    /\.sort\([\s\S]{0,180}String\(right\.updatedAt/
  );
  assert.match(storage, /at: toIso\(row\.finalizedAt \|\| row\.createdAt\)/);
});

test("central retoma y finaliza sin reemplazar al asesor propietario", async () => {
  const [draftRoute, creditRoute, storage, factory] = await Promise.all([
    readProjectFile("app/api/creditos/borradores/route.ts"),
    readProjectFile("app/api/creditos/route.ts"),
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  ]);

  assert.match(
    draftRoute,
    /access\.central && draftId[\s\S]*getActiveSolicitudCreditContext\(draftId\)/
  );
  assert.match(
    draftRoute,
    /usuarioId: owner\.usuarioId[\s\S]*vendedorId: owner\.vendedorId[\s\S]*sedeId: owner\.sedeId/
  );
  assert.doesNotMatch(storage, /allowCentralAdminAccess/);
  assert.match(factory, /solicitudId: draftId/);

  assert.match(
    creditRoute,
    /canOperateSolicitud[\s\S]*adminCentral[\s\S]*solicitudContext\.vendedorId === sellerSession\.id/
  );
  assert.match(creditRoute, /SOLICITUD_DOCUMENTO_DIFERENTE/);
  assert.match(creditRoute, /SOLICITUD_DATACREDITO_DIFERENTE/);
  assert.match(
    storage,
    /getActiveSolicitudCreditContext[\s\S]*d\."estado" = 'ABIERTO'[\s\S]*INTERVAL '15 days'/
  );
  assert.ok(
    (creditRoute.match(/creditOwner\.usuarioId/g) || []).length >= 3,
    "DataCrédito, el crédito y el cierre deben conservar el usuario propietario"
  );
  assert.ok(
    (creditRoute.match(/creditOwner\.vendedorId/g) || []).length >= 3,
    "DataCrédito, el crédito y el cierre deben conservar el asesor propietario"
  );
  assert.ok(
    (creditRoute.match(/creditOwner\.sedeId/g) || []).length >= 3,
    "DataCrédito, el crédito y el cierre deben conservar la sede propietaria"
  );
});

test("la interfaz conserva filtros en URL y confirma el desistimiento", async () => {
  const ui = await readProjectFile(
    "app/dashboard/solicitudes/solicitudes-wall-client.tsx"
  );
  assert.match(ui, /useSearchParams/);
  assert.match(ui, /new URLSearchParams|URLSearchParams\(/);
  assert.match(ui, /router\.(?:replace|push)/);
  assert.match(ui, /cedula|cédula/i);
  assert.match(ui, /IMEI/);
  for (const filter of [
    "desde",
    "hasta",
    "aliadoId",
    "sedeId",
    "asesorId",
    "plataforma",
    "estado",
  ]) {
    assert.match(ui, new RegExp(filter));
  }
  assert.match(ui, /DESISTIR/);
  assert.match(ui, /ABRIR_FABRICA/);
  assert.match(ui, /factoryHref/);
  assert.match(ui, /mode=correction/);
  assert.match(ui, /ConfirmDialog/);
});

test("el muro enlaza la correccion aprobada sin convertir el detalle en fabrica", async () => {
  const [storage, ui] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  ]);

  assert.match(
    storage,
    /creditHref:[\s\S]{0,180}mode=correction&selected=\$\{row\.entityId\}/
  );
  assert.match(
    ui,
    /actions\.includes\("ABRIR_FABRICA"\)[\s\S]{0,220}<Link[\s\S]{0,220}factoryHref/
  );
  assert.match(
    ui,
    /:\s*item\.actions\.includes\("VER_DETALLE"\)[\s\S]{0,180}openDetail\(item\)/
  );
});

test("la respuesta y la interfaz no exponen puntajes", async () => {
  const [route, ui] = await Promise.all([
    readProjectFile("app/api/solicitudes/route.ts"),
    readProjectFile("app/dashboard/solicitudes/solicitudes-wall-client.tsx"),
  ]);
  assert.doesNotMatch(`${route}\n${ui}`, /\bscore\b|\bpuntaje\b|providerPayload/i);
});

test("reserva globalmente la cedula antes de consultar al proveedor", async () => {
  const [storage, evaluationRoute] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("app/api/creditos/datacredito/evaluaciones/route.ts"),
  ]);

  assert.match(storage, /pg_advisory_xact_lock/);
  assert.match(storage, /solicitud:\$\{lockDigest\(kind, value\)\}/);
  assert.match(storage, /"estado" = 'ABIERTO'/);
  assert.match(storage, /ActiveSolicitudConflictError/);
  assert.match(storage, /EXPIRADA_15_DIAS/);
  assert.match(storage, /INTERVAL '15 days'/);

  const reservation = evaluationRoute.indexOf(
    "const solicitudReservation = await reserveSolicitudForIdentity"
  );
  const reuse = evaluationRoute.indexOf(
    "const cached = await reuseDataCreditoAssessment"
  );
  const providerCall = evaluationRoute.indexOf(
    "await queryDataCreditoNaturalPerson({"
  );
  assert.ok(reservation >= 0, "debe reservar la solicitud");
  assert.ok(reuse > reservation, "debe reservar antes de reutilizar DataCredito");
  assert.ok(providerCall > reuse, "debe reutilizar antes de consultar al proveedor");
});

test("cierra y vincula el borrador dentro de la transaccion del credito", async () => {
  const [creditRoute, storage] = await Promise.all([
    readProjectFile("app/api/creditos/route.ts"),
    readProjectFile("lib/solicitudes-storage.ts"),
  ]);

  const transaction = creditRoute.indexOf(
    "const createCreditWithAmortization = async"
  );
  const completion = creditRoute.indexOf(
    "const linkedSolicitudId = await completeSolicitudForCredit"
  );
  const consume = creditRoute.indexOf(
    "const consumed = await consumeDataCreditoAssessment"
  );
  assert.ok(transaction >= 0);
  assert.ok(completion > transaction);
  assert.ok(consume > completion);
  assert.match(storage, /"closedReason" = 'FINALIZADA'/);
  assert.match(storage, /"creditoId" = \$7/);
});

test("Railway prepara el esquema y produccion solo lo verifica", async () => {
  const [storage, predeploy, dockerfile, schemaScript] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile("scripts/railway-predeploy.mjs"),
    readProjectFile("Dockerfile"),
    readProjectFile("scripts/ensure-solicitudes-schema.mjs"),
  ]);

  assert.match(
    storage,
    /process\.env\.NODE_ENV === "production"[\s\S]*?information_schema\.columns[\s\S]*?return;[\s\S]*?CREATE TABLE/
  );
  assert.match(predeploy, /ensure-solicitudes-schema\.mjs/);
  assert.match(dockerfile, /ensure-solicitudes-schema\.mjs/);
  assert.match(schemaScript, /BEGIN/);
  assert.match(schemaScript, /pg_advisory_xact_lock/);
  assert.match(
    schemaScript,
    /WHERE "estado" = 'ABIERTO' AND "expiresAt" IS NULL/
  );
  assert.match(schemaScript, /COMMIT/);
});
