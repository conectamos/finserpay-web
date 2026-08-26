import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  getIphoneClosureReadiness,
  getMissingIphoneDeliveryEvidence,
  getMissingIphoneIdentityEvidence,
  hasDuplicateEvidenceValues,
} = await jiti.import(
  "../lib/credit-factory.ts"
);
const { sanitizeIphoneDeliveryEvidenceDataUrl } = await jiti.import(
  "../lib/iphone-delivery-evidence.ts"
);

const [factoryConsole, creditRoute, schema, documentsRoute, prismaSource, draftsRoute, commandRoute, firmaSeguroRoute] = await Promise.all([
  readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  readProjectFile("app/api/creditos/route.ts"),
  readProjectFile("prisma/schema.prisma"),
  readProjectFile("app/api/creditos/[id]/documentos/route.ts"),
  readProjectFile("lib/prisma.ts"),
  readProjectFile("app/api/creditos/borradores/route.ts"),
  readProjectFile("app/api/creditos/[id]/command/route.ts"),
  readProjectFile("app/api/creditos/borradores/[id]/firma-seguro/route.ts"),
]);

const jpegPayload =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL2AD//Z";
const pngPayload =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX///+nxBvIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const webpPayload =
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=";
const jpeg = `data:image/jpeg;base64,${jpegPayload}`;
const png = `data:image/png;base64,${pngPayload}`;
const webp = `data:image/webp;base64,${webpPayload}`;

test("exige entrega y remision solo para creditos iPhone", () => {
  assert.deepEqual(
    getMissingIphoneDeliveryEvidence({ platform: "ANDROID" }),
    []
  );

  for (const platform of ["IPHONE", "ios", "Apple"]) {
    assert.deepEqual(
      getMissingIphoneDeliveryEvidence({ platform }),
      ["fotoEntrega", "fotoRemision"]
    );
    assert.deepEqual(
      getMissingIphoneDeliveryEvidence({
        platform,
        fotoEntregaDataUrl: jpeg,
      }),
      ["fotoRemision"]
    );
    assert.deepEqual(
      getMissingIphoneDeliveryEvidence({
        platform,
        fotoRemisionDataUrl: png,
      }),
      ["fotoEntrega"]
    );
    assert.deepEqual(
      getMissingIphoneDeliveryEvidence({
        platform,
        fotoEntregaDataUrl: jpeg,
        fotoRemisionDataUrl: png,
      }),
      []
    );
  }
});

test("exige cedula por ambos lados y selfie con cedula solo para iPhone", () => {
  assert.deepEqual(
    getMissingIphoneIdentityEvidence({ platform: "ANDROID" }),
    []
  );

  for (const platform of ["IPHONE", "ios", "Apple"]) {
    assert.deepEqual(
      getMissingIphoneIdentityEvidence({ platform }),
      ["cedulaFrente", "cedulaRespaldo", "selfieCedula"]
    );
    assert.deepEqual(
      getMissingIphoneIdentityEvidence({
        platform,
        cedulaFrenteDataUrl: jpeg,
        cedulaRespaldoDataUrl: png,
      }),
      ["selfieCedula"]
    );
    assert.deepEqual(
      getMissingIphoneIdentityEvidence({
        platform,
        cedulaFrenteDataUrl: jpeg,
        cedulaRespaldoDataUrl: png,
        selfieCedulaDataUrl: jpeg,
      }),
      []
    );
  }
});

test("el cierre iPhone exige enrolamiento y cinco evidencias guardadas", () => {
  const evidence = {
    platform: "IPHONE",
    cedulaFrenteDataUrl: jpeg,
    cedulaRespaldoDataUrl: png,
    selfieCedulaDataUrl: webp,
    fotoEntregaDataUrl: jpeg,
    fotoRemisionDataUrl: png,
  };

  assert.deepEqual(getIphoneClosureReadiness(evidence), {
    isIphone: true,
    enrollmentConfirmed: false,
    missingEvidence: [],
    evidenceCount: 5,
    requiredEvidenceCount: 5,
    evidenceComplete: true,
    complete: false,
  });

  assert.equal(
    getIphoneClosureReadiness({
      ...evidence,
      enrollmentConfirmed: true,
    }).complete,
    true
  );

  const afterRemovingOne = getIphoneClosureReadiness({
    ...evidence,
    enrollmentConfirmed: true,
    fotoRemisionDataUrl: "",
  });
  assert.equal(afterRemovingOne.evidenceCount, 4);
  assert.deepEqual(afterRemovingOne.missingEvidence, ["fotoRemision"]);
  assert.equal(afterRemovingOne.complete, false);

  assert.deepEqual(
    getIphoneClosureReadiness({ platform: "ANDROID" }),
    {
      isIphone: false,
      enrollmentConfirmed: true,
      missingEvidence: [],
      evidenceCount: 0,
      requiredEvidenceCount: 0,
      evidenceComplete: true,
      complete: true,
    }
  );
});

test("rechaza reutilizar una foto entre las evidencias de identidad", () => {
  assert.equal(hasDuplicateEvidenceValues(["frente", "respaldo", "selfie"]), false);
  assert.equal(hasDuplicateEvidenceValues(["frente", "respaldo", "frente"]), true);
  assert.equal(hasDuplicateEvidenceValues(["", "selfie"]), false);
});

test("el sanitizador iPhone decodifica imagenes y acepta solo JPEG/PNG", async () => {
  for (const value of [
    jpeg,
    `data:image/jpg;base64,${jpegPayload}`,
    png,
  ]) {
    assert.equal(await sanitizeIphoneDeliveryEvidenceDataUrl(value), value);
  }

  const truncatedJpeg = Buffer.from(jpegPayload, "base64")
    .subarray(0, -2)
    .toString("base64");
  const truncatedPng = Buffer.from(pngPayload, "base64")
    .subarray(0, -12)
    .toString("base64");
  const webpWithInvalidLength = Buffer.from(webpPayload, "base64");
  webpWithInvalidLength[4] = 0;
  const fakePng = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakePng, 0);
  Buffer.from("IHDR").copy(fakePng, 12);
  Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]).copy(fakePng, 33);


  for (const value of [
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/plain;base64,AA==",
    "archivo-no-valido",
    `data:image/jpeg;base64,${pngPayload}`,
    `data:image/jpeg;base64,${truncatedJpeg}`,
    `data:image/png;base64,${truncatedPng}`,
    `data:image/webp;base64,${webpWithInvalidLength.toString("base64")}`,
    "data:image/jpeg;base64,/9j/2Q==",
    webp,
    `data:image/png;base64,${fakePng.toString("base64")}`,
    png.replace(/gg==$/, "gh=="),
    png.replace(",", ",\n"),
  ]) {
    assert.equal(await sanitizeIphoneDeliveryEvidenceDataUrl(value), "");
  }

  assert.equal(
    await sanitizeIphoneDeliveryEvidenceDataUrl(
      `data:image/jpeg;base64,${"A".repeat(2_500_000)}`
    ),
    ""
  );
});

test("el formulario integra HEIC, camara, borrador, cierre y envio final", () => {
  assert.match(factoryConsole, /import\("heic2any"\)/);
  assert.match(factoryConsole, /"foto-entrega"/);
  assert.match(factoryConsole, /"foto-remision"/);
  assert.match(factoryConsole, /"selfie-cedula"/);
  assert.match(factoryConsole, /Cédula frontal/);
  assert.match(factoryConsole, /Cédula posterior/);
  assert.match(factoryConsole, /Selfie con cédula/);
  assert.match(factoryConsole, /Foto de entrega/);
  assert.match(factoryConsole, /Foto de remisión/);
  assert.match(factoryConsole, /iphoneSelfieCedulaDataUrl/);
  assert.match(factoryConsole, /setIphoneSelfieCedulaDataUrl/);
  assert.match(factoryConsole, /iphoneSelfieWithDocumentReady/);
  assert.ok(factoryConsole.includes('aria-label={`Agregar foto de ${title.toLowerCase()}`}'));
  assert.match(factoryConsole, /fotoEntregaDataUrl/);
  assert.match(factoryConsole, /fotoRemisionDataUrl/);
  assert.match(factoryConsole, /setFotoEntregaDataUrl\(""\)/);
  assert.match(factoryConsole, /setFotoRemisionDataUrl\(""\)/);
  assert.match(factoryConsole, /getIphoneClosureReadiness/);
  assert.match(factoryConsole, /iphoneDeliveryEvidenceReady/);
  assert.match(factoryConsole, /iphoneRequiredEvidenceReady/);
  assert.match(factoryConsole, /persistedIphoneClosureFingerprint/);
  assert.match(factoryConsole, /iphoneEnrolamientoConfirmadoAt/);
  assert.match(factoryConsole, /Finalizar credito/);
  assert.doesNotMatch(factoryConsole, /ABRIR SAFEUEM|Abrir SafeUEM/);
});

test("la API exige las cinco evidencias iPhone y conserva la auditoria", () => {
  assert.match(creditRoute, /IPHONE_CLOSURE_EVIDENCE_REQUIRED/);
  assert.match(creditRoute, /IPHONE_ENROLLMENT_REQUIRED/);
  assert.match(creditRoute, /getIphoneClosureReadiness/);
  assert.match(creditRoute, /sanitizeIphoneDeliveryEvidenceDataUrl\(\s*body\.iphoneSelfieCedulaDataUrl/);
  assert.match(creditRoute, /selfieCedulaDataUrl: iphoneSelfieCedulaDataUrl/);
  assert.match(creditRoute, /IPHONE_IDENTITY_EVIDENCE_DUPLICATED/);
  assert.match(creditRoute, /hasDuplicateEvidenceValues\(iphoneIdentityHashes\)/);
  assert.match(creditRoute, /contratoFotoDataUrl = isIphoneCredit/);
  assert.match(creditRoute, /sanitizeIphoneDeliveryEvidenceDataUrl\(\s*body\.contratoCedulaFrenteDataUrl/);
  assert.match(creditRoute, /sanitizeIphoneDeliveryEvidenceDataUrl\(\s*body\.contratoCedulaRespaldoDataUrl/);
  assert.match(creditRoute, /missingEvidence/);
  assert.match(creditRoute, /enrolamientoManualAuditoria/);
  assert.match(creditRoute, /registradoAt/);
  assert.match(creditRoute, /fotoEntregaDataUrl = isIphoneCredit/);
  assert.match(creditRoute, /sanitizeIphoneDeliveryEvidenceDataUrl\(body\.fotoEntregaDataUrl\)/);
  assert.match(creditRoute, /sanitizeIphoneDeliveryEvidenceDataUrl\(body\.fotoRemisionDataUrl\)/);
  assert.match(creditRoute, /fotoEntrega:\s*fotoEntregaDataUrl\s*\?/);
  assert.match(creditRoute, /fotoRemision:\s*fotoRemisionDataUrl\s*\?/);
  assert.match(creditRoute, /sha256:\s*fotoEntregaSha256/);
  assert.match(creditRoute, /sha256:\s*fotoRemisionSha256/);
  assert.match(creditRoute, /fotoEntregaDataUrl,\s*fotoRemisionDataUrl,/);
  assert.match(
    creditRoute,
    /const creditListOmit = \{[\s\S]*?iphoneSelfieCedulaDataUrl: true,[\s\S]*?fotoEntregaDataUrl: true,[\s\S]*?fotoRemisionDataUrl: true,[\s\S]*?\} satisfies Prisma\.CreditoOmit;/
  );
  assert.equal(
    (creditRoute.match(/include: creditListInclude,\s*omit: creditListOmit,/g) || [])
      .length,
    5
  );
  assert.doesNotMatch(creditRoute, /fotoEntregaLista|fotoRemisionLista/);
  assert.match(
    prismaSource,
    /const GLOBAL_OMIT = \{[\s\S]*?iphoneSelfieCedulaDataUrl: true,[\s\S]*?fotoEntregaDataUrl: true,[\s\S]*?fotoRemisionDataUrl: true,/
  );
  assert.match(commandRoute, /iphoneSelfieCedulaDataUrl: true/);
  assert.match(firmaSeguroRoute, /delete firmaSeguroDraftPayload\.iphoneSelfieCedulaDataUrl/);
  assert.match(firmaSeguroRoute, /delete firmaSeguroDraftPayload\.iphoneSelfieCedulaCapturedAt/);
  assert.match(firmaSeguroRoute, /delete firmaSeguroDraftPayload\.iphoneSelfieCedulaSource/);
  assert.match(firmaSeguroRoute, /draftPayload: firmaSeguroDraftPayload/);
  assert.match(documentsRoute, /iphoneSelfieCedulaDataUrl: false/);
  assert.match(documentsRoute, /fotoEntregaDataUrl: false/);
  assert.match(documentsRoute, /fotoRemisionDataUrl: false/);
  assert.match(draftsRoute, /- 'fotoEntregaDataUrl'/);
  assert.match(draftsRoute, /- 'iphoneSelfieCedulaDataUrl'/);
  assert.match(draftsRoute, /- 'fotoRemisionDataUrl'/);
  assert.match(draftsRoute, /- 'contratoSelfieDataUrl'/);
  assert.match(draftsRoute, /- 'contratoCedulaFrenteDataUrl'/);
  assert.match(draftsRoute, /- 'contratoCedulaRespaldoDataUrl'/);
  assert.match(draftsRoute, /readDrafts\(where\.join\(" AND "\), values, take, false\)/);


  assert.match(schema, /fotoEntregaDataUrl\s+String\?/);
  assert.match(schema, /fotoRemisionDataUrl\s+String\?/);
  assert.match(schema, /contratoSelfieDataUrl\s+String\?/);
  assert.match(schema, /contratoCedulaFrenteDataUrl\s+String\?/);
  assert.match(schema, /contratoCedulaRespaldoDataUrl\s+String\?/);
  assert.match(schema, /iphoneSelfieCedulaDataUrl\s+String\?/);
});

test("el expediente PDF anexa las cinco evidencias requeridas", () => {
  assert.match(documentsRoute, /Selfie del cliente/);
  assert.match(documentsRoute, /Cedula frente/);
  assert.match(documentsRoute, /Cedula respaldo/);
  assert.match(documentsRoute, /Selfie con cedula en mano/);
  assert.match(documentsRoute, /Foto de entrega del iPhone/);
  assert.match(documentsRoute, /Foto de remision/);
  assert.match(documentsRoute, /credito\.contratoSelfieDataUrl/);
  assert.match(documentsRoute, /credito\.contratoCedulaFrenteDataUrl/);
  assert.match(documentsRoute, /credito\.contratoCedulaRespaldoDataUrl/);
  assert.match(documentsRoute, /credito\.iphoneSelfieCedulaDataUrl/);
  assert.match(documentsRoute, /credito\.fotoEntregaDataUrl/);
  assert.match(documentsRoute, /credito\.fotoRemisionDataUrl/);
  assert.match(documentsRoute, /deliveryEvidenceHashes/);
  assert.match(documentsRoute, /identityEvidenceHashes/);
  assert.match(documentsRoute, /"Cache-Control": "private, no-store"/);
  assert.match(documentsRoute, /hashEvidenceDataUrl/);
  assert.match(documentsRoute, /EVIDENCIA NO RENDERIZABLE EN EXPEDIENTE/);
});

test("Railway prepara la columna iPhone antes de publicar la aplicacion", async () => {
  const [schemaGuard, dockerfile, railwayConfig, predeploy] = await Promise.all([
    readProjectFile("scripts/ensure-iphone-identity-evidence-column.mjs"),
    readProjectFile("Dockerfile"),
    readProjectFile("railway.toml"),
    readProjectFile("scripts/railway-predeploy.mjs"),
  ]);

  assert.match(schemaGuard, /ADD COLUMN IF NOT EXISTS "iphoneSelfieCedulaDataUrl" TEXT/);
  assert.match(schemaGuard, /SET LOCAL lock_timeout = '5s'/);
  assert.match(schemaGuard, /SET LOCAL statement_timeout = '30s'/);
  assert.match(schemaGuard, /data_type !== "text"/);
  assert.match(schemaGuard, /is_nullable !== "YES"/);
  assert.doesNotMatch(schemaGuard, /DROP\s+(COLUMN|TABLE)|DELETE\s+FROM|TRUNCATE/i);
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/scripts\/ensure-iphone-identity-evidence-column\.mjs/
  );
  assert.match(
    railwayConfig,
    /preDeployCommand = \[[\s\S]*"node scripts\/railway-predeploy\.mjs"[\s\S]*\]/
  );
  assert.match(
    predeploy,
    /import\("\.\/ensure-iphone-identity-evidence-column\.mjs"\)/
  );
});
