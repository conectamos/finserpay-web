import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const routeSource = readFileSync(
  new URL("../app/api/creditos/route.ts", import.meta.url),
  "utf8"
);
const firmaSeguroCreditSource = readFileSync(
  new URL("../lib/firmaseguro-credit.ts", import.meta.url),
  "utf8"
);
const firmaSeguroStorageSource = readFileSync(
  new URL("../lib/firmaseguro-storage.ts", import.meta.url),
  "utf8"
);
const solicitudStorageSource = readFileSync(
  new URL("../lib/solicitudes-storage.ts", import.meta.url),
  "utf8"
);

test("el cierre permite al admin central o al perfil comercial titular de la solicitud", () => {
  const postStart = routeSource.indexOf("export async function POST");
  const postSource = routeSource.slice(postStart);

  assert.ok(postStart >= 0);
  assert.match(
    postSource,
    /!adminCentral\s*&&\s*!isDirectSalesProfile\(sellerSession\?\.tipoPerfil\)/
  );
  assert.match(postSource, /!adminCentral && !requestedSolicitudId/);
  assert.match(postSource, /code: "SOLICITUD_REQUERIDA"/);
});

test("el reintento de una solicitud finalizada recupera su credito sin repetir efectos", () => {
  assert.match(
    routeSource,
    /getFinalizedSolicitudCreditContext\(requestedSolicitudId\)/
  );
  assert.match(
    routeSource,
    /draft\."closedReason" = 'FINALIZADA'[\s\S]*draft\."creditoId" IS NOT NULL/
  );
  assert.match(
    routeSource,
    /canRecoverFinalizedSolicitud[\s\S]*finalizedSolicitudRecoveredCreditResponse/
  );
  assert.match(
    routeSource,
    /recoverDataCreditoCredit\([\s\S]{0,180}requestedSolicitudId[\s\S]{0,180}adminCentral/
  );
  assert.match(
    routeSource,
    /completeSolicitudForCredit\([\s\S]{0,220}solicitudId/
  );
  assert.match(
    routeSource,
    /canViewSensitive \? serialized : redactCreditForNonAdmin\(serialized\)/
  );
});

test("el cierre exitoso oculta Veriff, Equality y campos sensibles al vendedor", () => {
  const successStart = routeSource.indexOf(
    "const serializedCreated = serializeCredit(created)"
  );
  const successResponse = routeSource.slice(
    successStart,
    routeSource.indexOf("} catch (error)", successStart)
  );

  assert.ok(successStart >= 0);
  assert.ok(
    successResponse.includes(
      "canViewSensitiveCredit\n        ? serializedCreated\n        : redactCreditForNonAdmin(serializedCreated)"
    ) ||
      successResponse.includes(
        "canViewSensitiveCredit\r\n        ? serializedCreated\r\n        : redactCreditForNonAdmin(serializedCreated)"
      )
  );
  assert.ok(
    successResponse.includes(
      "identityValidation: canViewSensitiveCredit"
    )
  );
  assert.ok(
    successResponse.includes(
      "equality: canViewSensitiveCredit && equalitySummary"
    )
  );
});

test("IMEI, deviceUid y plataforma quedan ligados a la solicitud antes de integraciones", () => {
  const imeiGuard = routeSource.indexOf('code: "IMEI_DEVICE_UID_DIFERENTES"');
  const canonicalGuard = routeSource.indexOf('code: "SOLICITUD_IMEI_DIFERENTE"');
  const platformGuard = routeSource.indexOf(
    'code: "SOLICITUD_PLATAFORMA_DIFERENTE"'
  );
  const dataCreditoConfig = routeSource.indexOf(
    "const dataCreditoProvider = getDataCreditoPublicConfig()"
  );

  assert.ok(imeiGuard >= 0);
  assert.ok(canonicalGuard > imeiGuard);
  assert.ok(platformGuard > canonicalGuard);
  assert.ok(dataCreditoConfig > platformGuard);
  assert.match(
    routeSource,
    /solicitudImei !== imei \|\| solicitudImei !== deviceUid/
  );
  assert.match(
    solicitudStorageSource,
    /await lockIdentity\(transaction, "imei", imei\)/
  );
  assert.match(
    solicitudStorageSource,
    /isCompleteImei\(storedImei\) && storedImei !== imei/
  );
  assert.match(
    solicitudStorageSource,
    /"imei" = COALESCE\(NULLIF\(\$3::text, ''\), "imei"\)/
  );
  assert.match(
    solicitudStorageSource,
    /WHEN \$3::text <> '' THEN jsonb_build_object\([\s\S]*?'imei', \$3::text,[\s\S]*?'deviceUid', \$3::text/
  );
  assert.match(
    solicitudStorageSource,
    /SOLICITUD_IMEI_INMUTABLE/
  );
  assert.match(
    solicitudStorageSource,
    /regexp_replace\(COALESCE\("imei", ''\)[\s\S]{0,120}= \$8/
  );
  assert.match(
    solicitudStorageSource,
    /UPPER\(COALESCE\("plataforma", ''\)\) = \$9/
  );
});

test("FirmaSeguro se vincula por UUID y draft dentro de la transaccion", () => {
  assert.match(
    firmaSeguroStorageSource,
    /WHERE "processUuid" = \$1[\s\S]*AND "draftId" = \$3[\s\S]*"creditoId" IS NULL OR "creditoId" = \$2/
  );
  assert.match(
    firmaSeguroCreditSource,
    /draftId: number,[\s\S]*database: Prisma\.TransactionClient \| typeof prisma/
  );

  const transactionStart = routeSource.indexOf(
    "const createCreditWithAmortization = async"
  );
  const transactionEnd = routeSource.indexOf("let creationResult", transactionStart);
  const transactionSource = routeSource.slice(transactionStart, transactionEnd);

  assert.match(
    transactionSource,
    /linkFirmaSeguroProcessForCredit\([\s\S]*solicitudReservation\.id,[\s\S]*transaction/
  );
  assert.match(
    transactionSource,
    /markCreditoFirmaSeguroCompleted\([\s\S]*transaction/
  );
  assert.match(transactionSource, /FIRMASEGURO_LINK_CONFLICT/);

  const afterCommitSource = routeSource.slice(transactionEnd);
  assert.doesNotMatch(afterCommitSource, /linkFirmaSeguroProcessForCredit\(/);
});

test("un proceso vigente no puede omitirse ni reemplazarse por una firma histórica al cerrar", async () => {
  const ast = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
  const statements = [];
  const visit = (node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
      (declaration) => ["currentFirmaSeguroProcess", "firmaSeguroWorkflowStarted"].includes(declaration.name.getText(ast))
    )) statements.push(node);
    if (ts.isIfStatement(node) && node.expression.getText(ast).startsWith("firmaSeguroWorkflowStarted &&")) {
      statements.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(statements.length, 3, "Debe ejecutarse el guard real del cierre");
  const source = statements.sort((left, right) => left.pos - right.pos).map((node) => node.getText(ast)).join("\n");
  const { outputText } = ts.transpileModule(`(async () => { ${source}\nreturn null; })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const process = { processUuid: "current-signature", draftId: 45 };

  for (const body of [
    {},
    { firmaSeguroPasoContratos: false, contratoFirmaDataUrl: "manual-signature" },
    { firmaSeguroPasoContratos: 0, firmaSeguroProcessUuid: process.processUuid },
    { firmaSeguroPasoContratos: true },
    { firmaSeguroPasoContratos: true, firmaSeguroProcessUuid: "historical-signature" },
    { firmaSeguroPasoContratos: true, firmaSeguroProcessUuid: "other-draft-signature" },
  ]) {
    let reads = 0;
    const response = await runInNewContext(outputText, {
      body, requestedSolicitudId: 45,
      sanitizeText: (value) => String(value ?? "").trim(),
      getLatestFirmaSeguroProcessByDraft: async (draftId) => {
        assert.equal(draftId, 45);
        reads++;
        return process;
      },
      hasFirmaSeguroDraftWorkflowStarted: async () => assert.fail("El proceso vigente ya acredita el inicio"),
      NextResponse: { json: (payload, options) => ({ payload, status: options.status }) },
    });
    assert.equal(reads, 1);
    assert.equal(response.status, 409);
    assert.equal(response.payload.code, "FIRMASEGURO_CURRENT_PROCESS_REQUIRED");
  }

  for (const [current, started, body] of [
    [process, true, { firmaSeguroPasoContratos: true, firmaSeguroProcessUuid: process.processUuid }],
    [null, false, { firmaSeguroPasoContratos: false, contratoFirmaDataUrl: "legacy-manual-signature" }],
  ]) {
    const result = await runInNewContext(outputText, {
      body, requestedSolicitudId: 45,
      sanitizeText: (value) => String(value ?? "").trim(),
      getLatestFirmaSeguroProcessByDraft: async () => current,
      hasFirmaSeguroDraftWorkflowStarted: async () => started,
      NextResponse: { json: () => assert.fail("No debe bloquear la firma vigente ni el flujo manual sin proceso") },
    });
    assert.equal(result, null);
  }

  for (const body of [
    { firmaSeguroPasoContratos: false, contratoFirmaDataUrl: "manual-after-correction" },
    { firmaSeguroPasoContratos: true, firmaSeguroProcessUuid: "archived-before-reissue" },
  ]) {
    const result = await runInNewContext(outputText, {
      body, requestedSolicitudId: 45,
      sanitizeText: (value) => String(value ?? "").trim(),
      getLatestFirmaSeguroProcessByDraft: async () => null,
      hasFirmaSeguroDraftWorkflowStarted: async () => true,
      NextResponse: { json: (payload, options) => ({ payload, status: options.status }) },
    });
    assert.equal(result.status, 409, "No debe cerrar entre archivar la firma anterior y emitir la nueva");
    assert.equal(result.payload.code, "FIRMASEGURO_CURRENT_PROCESS_REQUIRED");
  }

  const guardPosition = routeSource.indexOf("const currentFirmaSeguroProcess");
  assert.ok(guardPosition > routeSource.indexOf('code: "SOLICITUD_TITULAR_CAMBIO"'));
  assert.ok(guardPosition > routeSource.indexOf("await tryAcquireSolicitudOperationLock(requestedSolicitudId)"));
  assert.ok(guardPosition < routeSource.indexOf("const dataCreditoProvider = getDataCreditoPublicConfig()"));
  assert.ok(guardPosition < routeSource.indexOf("await refreshFirmaSeguroProcess(storedFirmaSeguroProcess)"));
});

test("el inicio de FirmaSeguro conserva históricos y despachos inciertos sin exigir tablas opcionales antiguas", async () => {
  const ast = ts.createSourceFile("storage.ts", firmaSeguroStorageSource, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "hasFirmaSeguroDraftWorkflowStarted");
  assert.ok(declaration);
  const { outputText } = ts.transpileModule(`${declaration.getText(ast)}\nmodule.exports = hasFirmaSeguroDraftWorkflowStarted;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  for (const [processStarted, dispatchTablePresent, dispatchStarted, expected, expectedReads] of [
    [true, false, false, true, 1],
    [true, true, false, true, 1],
    [false, false, false, false, 1],
    [false, true, true, true, 2],
    [false, true, false, false, 2],
  ]) {
    const queries = [];
    const testModule = { exports: {} };
    runInNewContext(outputText, { module: testModule, exports: testModule.exports, ensureFirmaSeguroSchema: async () => {},
      prisma: { $queryRawUnsafe: async (sql, draftId) => {
        assert.equal(draftId, 45);
        queries.push(sql);
        assert.ok(!sql.includes('"supersededAt"'), "Una firma archivada conserva el inicio del flujo");
        return queries.length === 1
          ? [{ started: processStarted, dispatchTablePresent }]
          : [{ started: dispatchStarted }];
      } },
    });
    assert.equal(await testModule.exports(45), expected);
    assert.equal(queries.length, expectedReads);
    if (expectedReads === 2) assert.ok(queries[1].includes('FROM "FirmaSeguroDraftDispatch" WHERE "draftId" = $1'));
  }
});
