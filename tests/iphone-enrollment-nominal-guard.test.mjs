import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule as load } from "./credit-approval-reissue-fixture.mjs";

const enrollment = load("lib/iphone-enrollment.ts", {}, { process: { env: {
  IPHONE_ENROLLMENT_ENABLED: "true",
  IPHONE_ENROLLMENT_SESSION_SECRET: "nominal-session-secret-for-tests-0123456789",
  IPHONE_ENROLLMENT_IDENTITY_PEPPER: "nominal-identity-pepper-for-tests-0123456789",
  IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION: "nominal-test-v1",
  IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET: "S".repeat(43),
} } });
const errors = load("lib/credit-approval-errors.ts");
const actors = load("lib/analyst-mora-access.ts", {
  "@/lib/auth": {}, "@/lib/approval-shared-session": {}, "@/lib/roles": {},
  "@/lib/credit-approval-errors": errors,
});
const grantId = "11111111-1111-4111-8111-111111111111";
const document = "1000000001", imei = "123456789012345";

function fixture(options = {}) {
  const session = options.shared ? enrollment.issueIphoneEnrollmentSharedPortalSession()
    : enrollment.issueIphoneEnrollmentPortalSession({ grantId,
      analyst: { name: "Analista nominal", externalId: options.externalId || "FINSER-USER:7" },
      grantExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) });
  const grant = {
    accessMode: session.payload.accessMode, grantId: session.payload.grantId,
    analyst: { name: session.payload.analystName, externalId: session.payload.analystExternalId },
    issuedBy: options.shared ? null : { userId: 7, name: "Analista nominal" },
    expiresAt: session.expiresAt, session: session.payload,
  };
  const row = { id: grantId, analystName: session.payload.analystName,
    analystExternalId: session.payload.analystExternalId,
    issuedByUserId: options.ownerId ?? 7, issuedByName: "Analista nominal",
    sessionExpiresAt: session.expiresAt, expiresAt: session.expiresAt,
    consumedAt: new Date(), revokedAt: null };
  const sequence = [], replacementCalls = [];
  const transaction = {
    $executeRawUnsafe: async sql => { sequence.push(sql); return 0; },
    $queryRawUnsafe: async sql => {
      sequence.push(sql);
      if (sql.includes('FROM "Usuario"')) return options.inactive ? [] : [{ nombre: "Analista nominal", role: "ANALISTA_APROBACION" }];
      if (sql.includes('FROM "IphoneEnrollmentAccessGrant"')) return options.revoked ? [] : [row];
      if (sql.includes('FROM "IphoneEnrollmentReview"')) return [];
      if (sql.includes('FROM "CreditoBorrador"')) return [];
      throw new Error("Unexpected SQL: " + sql);
    },
  };
  const service = load("lib/iphone-enrollment-storage.ts", {
    "@/lib/iphone-enrollment": enrollment,
    "@/lib/prisma": { default: { $executeRawUnsafe: async () => 0, $transaction: work => work(transaction) } },
    "@/lib/analyst-mora-access": actors,
    "@/lib/datacredito/storage": {},
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: async () => {}, FIRMASEGURO_DRAFT_LOCK_NAMESPACE: 1 },
    "@/lib/solicitudes-storage": { ensureSolicitudSchema: async () => {}, expireStaleSolicitudes: async () => {} },
    "@/lib/veriff-identity": {},
    "@/lib/credit-device-replacement-storage": {
      ensureCreditDeviceReplacementSchema: async () => {},
      approveCreditDeviceReplacementEnrollment: async input => { replacementCalls.push(input); return { alreadyApproved: false }; },
    },
    "@/lib/veriff-storage": { ensureVeriffSchema: async () => {} },
  });
  const token = enrollment.createIphoneEnrollmentCaseToken({ session: session.payload,
    solicitudId: 28, targetType: options.replacement ? "DEVICE_REPLACEMENT" : "APPLICATION",
    targetId: options.replacement ? "22222222-2222-4222-8222-222222222222" : null,
    documentHash: enrollment.hashIphoneEnrollmentDocument(document), imeiHash: enrollment.hashIphoneEnrollmentImei(imei) });
  const caseToken = enrollment.verifyIphoneEnrollmentCaseToken(token);
  assert.ok(caseToken);
  return { sequence, replacementCalls, service, run: () => service.approveIphoneEnrollmentCase({
    grant, caseToken, checklist: enrollment.buildIphoneEnrollmentChecklist(true),
    ...(options.legacy ? {} : { nominalActor: { id: 7 } }),
  }) };
}

for (const replacement of [false, true]) {
  test(`cuenta revocada bloquea confirmación nominal de ${replacement ? "garantía" : "venta"} antes de bloquear grant`, async () => {
    const f = fixture({ inactive: true, replacement });
    await assert.rejects(f.run, error => error.code === "FORBIDDEN" && error.status === 403);
    assert.equal(f.replacementCalls.length, 0);
    assert.equal(f.sequence.length, 1);
    assert.match(f.sequence[0], /u\."activo"=TRUE AND s\."activa"=TRUE AND a\."activo"=TRUE/);
    assert.match(f.sequence[0], /IN \('ADMIN','ANALISTA_APROBACION'\) FOR SHARE OF u,s,a/);
  });
}

for (const options of [{ ownerId: 8 }, { externalId: "FINSER-USER:8" }, { shared: true }, { revoked: true }]) {
  test(`grant ajeno, compartido o revocado no confirma enrolamiento nominal: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ ...options, replacement: true });
    await assert.rejects(f.run, error => error.code === "GRANT_NOT_ACTIVE");
    assert.equal(f.replacementCalls.length, 0);
    assert.ok(f.sequence.every(sql => !sql.includes('FROM "IphoneEnrollmentReview"')));
  });
}

test("cuenta y grant nominal propios conservan auditoría y verificaciones existentes de garantía", async () => {
  const f = fixture({ replacement: true });
  await f.run();
  assert.equal(f.replacementCalls.length, 1);
  assert.equal(f.replacementCalls[0].analyst.externalId, "FINSER-USER:7");
  assert.equal(f.replacementCalls[0].access.issuedByUserId, 7);
  assert.equal(f.replacementCalls[0].access.grantId, grantId);
  assert.match(f.sequence[0], /FROM "Usuario"/);
  assert.match(f.sequence[1], /FROM "IphoneEnrollmentAccessGrant"[\s\S]*FOR UPDATE/);
});

test("un grant nominal válido conserva la elegibilidad de venta y no fuerza aprobación", async () => {
  const f = fixture();
  await assert.rejects(f.run, error => error.code === "CASE_NOT_AVAILABLE");
  assert.ok(f.sequence.some(sql => sql.includes('FROM "CreditoBorrador"')));
  assert.equal(f.replacementCalls.length, 0);
});

test("la opción nominal no altera el portal público existente", async () => {
  const f = fixture({ legacy: true, replacement: true, externalId: "ESPECIALISTA-EXTERNO" });
  await f.run();
  assert.equal(f.replacementCalls.length, 1);
  assert.equal(f.replacementCalls[0].analyst.externalId, "ESPECIALISTA-EXTERNO");
  assert.ok(f.sequence.every(sql => !sql.includes('FROM "Usuario"')));
});


test("copiar un grant nominal al camino público no omite revocación ni confirma garantía", async () => {
  const f = fixture({ legacy: true, inactive: true, replacement: true });
  await assert.rejects(f.run, error => error.code === "GRANT_NOT_ACTIVE");
  assert.equal(f.replacementCalls.length, 0);
  assert.ok(f.sequence.every(sql => !sql.includes('FROM "IphoneEnrollmentReview"')));
  assert.ok(f.sequence.every(sql => !sql.includes('FROM "CreditoBorrador"')));
});

test("todo el namespace nominal queda reservado y el identificador externo tradicional sigue público", () => {
  const f = fixture();
  for (const externalId of ["FINSER-USER:7", "FINSER-USER:999", "FINSER-USER:malformed"]) {
    assert.equal(f.service.isNominalIphoneEnrollmentGrant({ analyst: { externalId } }), true);
  }
  assert.equal(f.service.isNominalIphoneEnrollmentGrant({ analyst: { externalId: "EXTERNAL-ANALYST" } }), false);
});
