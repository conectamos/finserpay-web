import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canSeeSensitiveSolicitudData,
  canViewSolicitud,
  getSolicitudActions,
  isSolicitudIdentityReleased,
  isSolicitudExpired,
  normalizeSolicitudFilters,
  resolveSolicitudDeliveryStage,
  resolveSolicitudProcessStage,
  resolveSolicitudStage,
  selectCanonicalSolicitudesByDocument,
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

test("aplica alcance central, de aliado, de sede y de asesor propietario", () => {
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
  assert.equal(canViewSolicitud(seller, anotherSite), true);
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
    [{ source: "DRAFT", draftState: "ABIERTO" }, "PROCESO"],
    [{ source: "DRAFT", dataCreditoStatus: "PENDING" }, "PROCESO"],
    [{ source: "DRAFT", dataCreditoStatus: "APROBADO" }, "PROCESO"],
    [{ source: "DRAFT", dataCreditoStatus: "RECHAZADO" }, "RECHAZADA"],
    [
      { source: "DRAFT", dataCreditoStatus: "APROBADO", veriffStatus: "REVIEW" },
      "PROCESO",
    ],
    [
      {
        source: "DRAFT",
        dataCreditoStatus: "APROBADO",
        veriffStatus: "APPROVED",
        currentStep: 4,
      },
      "PROCESO",
    ],
    [
      {
        source: "DRAFT",
        dataCreditoStatus: "APROBADO",
        veriffStatus: "APPROVED",
        firmaStatus: "SIGNED",
      },
      "PROCESO",
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

test("mantiene la etapa operativa separada del estado PROCESO", () => {
  assert.equal(
    resolveSolicitudProcessStage({ source: "DRAFT", dataCreditoStatus: "PENDING" }),
    "CONSULTA_PENDIENTE"
  );
  assert.equal(
    resolveSolicitudProcessStage({ source: "DRAFT", dataCreditoStatus: "APROBADO" }),
    null
  );
  assert.equal(
    resolveSolicitudProcessStage({
      source: "DRAFT",
      dataCreditoStatus: "APROBADO",
      veriffStatus: "REVIEW",
    }),
    "VALIDACION_FACIAL"
  );
  assert.equal(
    resolveSolicitudProcessStage({
      source: "DRAFT",
      dataCreditoStatus: "APROBADO",
      veriffStatus: "APPROVED",
      currentStep: 4,
    }),
    "CONTRATOS"
  );
  assert.equal(
    resolveSolicitudProcessStage({
      source: "DRAFT",
      dataCreditoStatus: "APROBADO",
      firmaStatus: "SIGNED",
    }),
    "LISTA_PARA_ENTREGA"
  );
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

test("solo desistimiento o vencimiento liberan la cedula canonica", () => {
  assert.equal(
    isSolicitudIdentityReleased({
      source: "DRAFT",
      draftState: "CERRADO",
      closedReason: "DESISTIDA",
    }),
    true
  );
  assert.equal(
    isSolicitudIdentityReleased({
      source: "DRAFT",
      draftState: "CERRADO",
      closedReason: "EXPIRADA_15_DIAS",
    }),
    true
  );
  for (const input of [
    { source: "DRAFT", draftState: "ABIERTO", closedReason: null },
    { source: "DRAFT", draftState: "CERRADO", closedReason: "RECHAZADA" },
    { source: "DRAFT", draftState: "CERRADO", closedReason: "FINALIZADA" },
    { source: "CREDIT", draftState: null, closedReason: null },
  ]) {
    assert.equal(isSolicitudIdentityReleased(input), false);
  }
});

test("el muro elige una sola solicitud reciente por cedula sin agrupar documentos vacios", () => {
  const rows = [
    {
      source: "DRAFT",
      entityId: 394,
      clienteDocumento: "93.448.416",
      createdAt: "2026-08-26T16:15:00.000Z",
    },
    {
      source: "DRAFT",
      entityId: 395,
      clienteDocumento: "93448416",
      createdAt: "2026-08-26T16:16:00.000Z",
    },
    {
      source: "DRAFT",
      entityId: 396,
      clienteDocumento: "93448416",
      createdAt: "2026-08-26T16:19:00.000Z",
    },
    {
      source: "DRAFT",
      entityId: 500,
      clienteDocumento: null,
      createdAt: "2026-08-26T16:20:00.000Z",
    },
    {
      source: "DRAFT",
      entityId: 501,
      clienteDocumento: "",
      createdAt: "2026-08-26T16:21:00.000Z",
    },
    {
      source: "DRAFT",
      entityId: 700,
      clienteDocumento: "10000001",
      createdAt: "2026-08-26T17:00:00.000Z",
    },
    {
      source: "CREDIT",
      entityId: 701,
      clienteDocumento: "10000001",
      createdAt: "2026-08-26T17:00:00.000Z",
    },
  ];

  const selected = selectCanonicalSolicitudesByDocument(rows);
  assert.deepEqual(
    selected.map((item) => `${item.source}-${item.entityId}`),
    ["DRAFT-396", "DRAFT-500", "DRAFT-501", "CREDIT-701"]
  );
});

test("un credito finalizado es siempre el canonico aunque exista un borrador mas reciente", () => {
  const selected = selectCanonicalSolicitudesByDocument([
    {
      source: "CREDIT",
      entityId: 801,
      clienteDocumento: "1.083.028.847",
      createdAt: "2026-08-20T12:00:00.000Z",
      rawState: "ENTREGABLE",
    },
    {
      source: "DRAFT",
      entityId: 802,
      clienteDocumento: "1083028847",
      createdAt: "2026-08-26T12:00:00.000Z",
      rawState: "CERRADO",
      closedReason: "RECHAZADA",
    },
  ]);

  assert.deepEqual(
    selected.map((item) => `${item.source}-${item.entityId}`),
    ["CREDIT-801"]
  );
});

test("una solicitud no liberada prevalece sobre una desistida mas reciente", () => {
  const selected = selectCanonicalSolicitudesByDocument([
    {
      source: "DRAFT",
      entityId: 901,
      clienteDocumento: "93448416",
      createdAt: "2026-08-20T12:00:00.000Z",
      rawState: "CERRADO",
      closedReason: "RECHAZADA",
    },
    {
      source: "DRAFT",
      entityId: 902,
      clienteDocumento: "93.448.416",
      createdAt: "2026-08-26T12:00:00.000Z",
      rawState: "CERRADO",
      closedReason: "DESISTIDA",
    },
  ]);

  assert.deepEqual(
    selected.map((item) => `${item.source}-${item.entityId}`),
    ["DRAFT-901"]
  );
});

test("la fabrica del borrador respeta central, aliado, sede y asesor titular", () => {
  const openDraft = {
    ownership: ownSolicitud,
    source: "DRAFT",
    state: "PROCESO",
    draftState: "ABIERTO",
  };
  assert.deepEqual(getSolicitudActions({ viewer: seller, ...openDraft }), [
    "VER_DETALLE",
    "ABRIR_FABRICA",
    "DESISTIR",
  ]);
  assert.deepEqual(
    getSolicitudActions({
      viewer: seller,
      ...openDraft,
      ownership: { ...ownSolicitud, sedeId: 102 },
    }),
    ["VER_DETALLE"]
  );
  assert.deepEqual(
    getSolicitudActions({
      viewer: seller,
      ...openDraft,
      state: "RECHAZADA",
      draftState: "CERRADO",
    }),
    ["VER_DETALLE", "DESISTIR"]
  );
  assert.deepEqual(
    getSolicitudActions({
      viewer: centralAdmin,
      ...openDraft,
      state: "RECHAZADA",
      draftState: "CERRADO",
    }),
    ["VER_DETALLE", "DESISTIR"]
  );
  assert.deepEqual(getSolicitudActions({ viewer: supervisor, ...openDraft }), [
    "VER_DETALLE",
  ]);
  assert.deepEqual(getSolicitudActions({ viewer: allyAdmin, ...openDraft }), [
    "VER_DETALLE",
  ]);
  assert.deepEqual(getSolicitudActions({ viewer: centralAdmin, ...openDraft }), [
    "VER_DETALLE",
    "ABRIR_FABRICA",
    "DESISTIR",
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
  const [route, storage] = await Promise.all([
    readProjectFile("app/api/solicitudes/route.ts"),
    readProjectFile("lib/solicitudes-storage.ts"),
  ]);
  assert.match(route, /getSessionUser|getDashboardSession|requireDashboardSession/);
  assert.match(route, /normalizeSolicitudFilters/);
  assert.match(route, /viewer|SolicitudViewer/);
  assert.match(route, /Cache-Control[\s\S]{0,100}no-store|no-store[\s\S]{0,100}Cache-Control/i);
  assert.match(route, /DESISTIR/);
  assert.match(route, /CENTRAL_ADMIN[\s\S]*desistSolicitudAsCentralAdmin/);
  assert.match(route, /identityReleased: result\.identityReleased/);
  assert.match(
    storage,
    /desistSolicitudAsCentralAdmin[\s\S]*"closedReason" = 'DESISTIDA'[\s\S]*"desistedBySellerId" = NULL/
  );
  assert.doesNotMatch(route, /export\s+async\s+function\s+DELETE/);
  assert.doesNotMatch(storage, /DELETE\s+FROM\s+"CreditoBorrador"/i);
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
    /String\(right\.(?:item\.)?createdAt \|\| ""\)\.localeCompare\(\s*String\(left\.(?:item\.)?createdAt \|\| ""\)\s*\)/
  );
  assert.doesNotMatch(
    storage,
    /\.sort\([\s\S]{0,180}String\(right\.updatedAt/
  );
  assert.match(storage, /at: toIso\(row\.finalizedAt \|\| row\.createdAt\)/);
});

test("central retoma y finaliza sin reemplazar al asesor propietario", async () => {
  const [draftRoute, creditRoute, storage, factory, assessmentRoute, gate] =
    await Promise.all([
      readProjectFile("app/api/creditos/borradores/route.ts"),
      readProjectFile("app/api/creditos/route.ts"),
      readProjectFile("lib/solicitudes-storage.ts"),
      readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
      readProjectFile("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
      readProjectFile(
        "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
      ),
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
  assert.match(factory, /initialSolicitudId={draftId}/);
  assert.match(
    factory,
    /restoredDraftSnapshotRef = useRef<\{[\s\S]*wizardStep: number;[\s\S]*plazoMeses: string;[\s\S]*fechaPrimerPago: string;[\s\S]*frecuenciaPago: string;[\s\S]*fianzaPorcentaje: string;/
  );
  assert.match(
    factory,
    /if \(restoringDraftAssessment\) \{[\s\S]{0,180}cancelPendingDraftAutosave\(\);[\s\S]{0,140}applyingDraftRef\.current = true;[\s\S]{0,140}\} else if \(result\.solicitudId\)/
  );
  assert.match(
    factory,
    /restoringDraftAssessment && restoredDraftSnapshot[\s\S]{0,220}parseCreditInstallmentSelection\([\s\S]{0,120}restoredDraftSnapshot\.plazoMeses/
  );
  assert.match(
    factory,
    /normalizePaymentFrequency\(restoredDraftSnapshot\.frecuenciaPago\)[\s\S]{0,500}restoredDraftSnapshot\.fechaPrimerPago/
  );
  assert.match(
    factory,
    /setDataCreditoApproval\(approvedResult\)[\s\S]{0,400}setFianzaPorcentaje\(String\(restoredSuretyPercentage\)\)[\s\S]{0,400}setWizardStep\(restoredDraftSnapshot\.wizardStep\)/
  );
  assert.match(
    factory,
    /preservedTerms\?\.restoringDraft[\s\S]{0,160}cancelPendingDraftAutosave\(\);[\s\S]{0,120}applyingDraftRef\.current = true;/
  );
  assert.doesNotMatch(
    factory,
    /!restoringDraftAssessment && wizardStep !== 1/
  );
  assert.match(gate, /initialSolicitudId[\s\S]*assessmentParams\.set\("draftId"/);
  assert.match(
    assessmentRoute,
    /isFinserPayCentralAlly[\s\S]*getActiveSolicitudCreditContext\(draftId\)[\s\S]*assessmentBelongsToCentralDraft/
  );
  assert.doesNotMatch(assessmentRoute, /queryDataCreditoNaturalPerson/);
  assert.match(draftRoute, /canonicalAssessmentId[\s\S]*serializedPayload/);
  assert.match(
    draftRoute,
    /d\."dataCreditoAssessmentId"[\s\S]*\$\{payload\} AS "payload"/
  );

  assert.match(
    creditRoute,
    /canOperateSolicitud[\s\S]*adminCentral[\s\S]*solicitudContext\.vendedorId === sellerSession\.id/
  );
  assert.match(
    creditRoute,
    /reserveSolicitudForIdentity\(\{[\s\S]*solicitudId: solicitudContext\?\.id \|\| null/
  );
  assert.match(
    storage,
    /if \(input\.solicitudId\)[\s\S]*WHERE "id" = \$1[\s\S]*return \{ id: selected\[0\]\.id, reused: true \}/
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
  assert.match(ui, /identityReleased/);
  assert.match(ui, /administrador central debe gestionarlos/);
  assert.match(ui, /style=\{\{ paddingLeft: "2\.5rem" \}\}/);
});

test("el asesor consulta sus solicitudes propias sin quedar atado a la sede activa", async () => {
  const storage = await readProjectFile("lib/solicitudes-storage.ts");
  const commonWhere = storage.slice(
    storage.indexOf("function buildCommonWhere"),
    storage.indexOf("async function readDraftRows")
  );

  assert.match(commonWhere, /viewer\.kind === "SUPERVISOR"/);
  assert.doesNotMatch(
    commonWhere,
    /viewer\.kind === "SUPERVISOR" \|\| viewer\.kind === "SELLER"/
  );
  assert.match(
    commonWhere,
    /viewer\.kind === "SELLER"[\s\S]*vendedorId/
  );
  assert.match(commonWhere, /s\."aliadoId" =/);
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
  assert.match(storage, /findBlockingSolicitudByDocument/);
  assert.match(storage, /FROM "CreditoBorrador" draft[\s\S]*UNION ALL[\s\S]*FROM "Credito" credit/);
  assert.match(
    storage,
    /findBlockingSolicitudByDocument[\s\S]*candidate\."source" = 'CREDIT'[\s\S]*candidate\."createdAt" DESC/
  );
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

test("consolida duplicados antes de filtrar, ajusta la pagina y retira la nueva consulta tras rechazo", async () => {
  const [storage, gate] = await Promise.all([
    readProjectFile("lib/solicitudes-storage.ts"),
    readProjectFile(
      "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
    ),
  ]);
  const list = storage.slice(
    storage.indexOf("export async function listSolicitudes"),
    storage.indexOf("export async function getSolicitudDetail")
  );

  assert.match(
    storage,
    /function scopeOnlyFilters[\s\S]*q:\s*""[\s\S]*desde:\s*""[\s\S]*hasta:\s*""[\s\S]*estado:\s*""[\s\S]*id:\s*""/
  );
  assert.match(list, /const scopeFilters = scopeOnlyFilters\(input\.filters\)/);
  assert.match(list, /readDraftRows\(input\.viewer, scopeFilters\)/);
  assert.match(list, /readCreditRows\(input\.viewer, scopeFilters\)/);
  assert.match(list, /const rawRows = \[\.\.\.drafts, \.\.\.credits\]/);
  assert.match(list, /selectCanonicalSolicitudesByDocument\(rawRows\)/);
  assert.ok(
    list.indexOf("selectCanonicalSolicitudesByDocument") <
      list.indexOf("matchesOperationalFilters")
  );
  assert.ok(
    list.indexOf("matchesOperationalFilters") <
      list.indexOf("const total = all.length")
  );
  assert.match(list, /const totalPages = Math\.max\(1, Math\.ceil\(total \/ input\.filters\.pageSize\)\)/);
  assert.match(list, /const page = Math\.min\(input\.filters\.page, totalPages\)/);
  assert.match(list, /const start = \(page - 1\) \* input\.filters\.pageSize/);
  assert.match(list, /page,[\s\S]*filters:\s*\{\s*\.\.\.input\.filters,\s*page\s*\}/);
  assert.doesNotMatch(gate, /Realizar nueva consulta/);
  assert.match(gate, /SOLICITUD_ACTIVA_EXISTENTE/);
  assert.match(gate, /Ver solicitud en el muro|Buscar en mi muro/);
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
