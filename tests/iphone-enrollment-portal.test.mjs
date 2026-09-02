import assert from "node:assert/strict";
import { after, before } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readProjectFile = (file) =>
  readFile(path.join(projectRoot, file), "utf8");

const environmentKeys = [
  "IPHONE_ENROLLMENT_ENABLED",
  "IPHONE_ENROLLMENT_SESSION_SECRET",
  "IPHONE_ENROLLMENT_IDENTITY_PEPPER",
  "IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION",
  "IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET",
  "IPHONE_ENROLLMENT_PUBLIC_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "NODE_ENV",
];
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
);

const sessionSecret = "session-secret-for-tests-0123456789abcdef";
const identityPepper = "identity-pepper-for-tests-0123456789abcdef";
const identityKeyVersion = "test-v7";
const sharedAccessSecret = "S".repeat(43);
const testGrantId = "11111111-1111-4111-8111-111111111111";
const secondGrantId = "22222222-2222-4222-8222-222222222222";

before(() => {
  process.env.IPHONE_ENROLLMENT_ENABLED = "true";
  process.env.IPHONE_ENROLLMENT_SESSION_SECRET = sessionSecret;
  process.env.IPHONE_ENROLLMENT_IDENTITY_PEPPER = identityPepper;
  process.env.IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION = identityKeyVersion;
  process.env.IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET = sharedAccessSecret;
  process.env.IPHONE_ENROLLMENT_PUBLIC_ORIGIN = "https://finserpay.com";
  process.env.NEXT_PUBLIC_APP_URL = "https://finserpay.com";
  process.env.NODE_ENV = "test";
});

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const enrollment = await import("../lib/iphone-enrollment.ts");

const [
  storageSource,
  accessRouteSource,
  sessionRouteSource,
  casesRouteSource,
  approveRouteSource,
  adminAccessRouteSource,
  sellerStatusRouteSource,
  draftRouteSource,
  creditRouteSource,
  factorySource,
  portalSource,
  adminPageSource,
  adminManagerSource,
  sidebarSource,
  proxySource,
  schemaSource,
  predeploySource,
  dockerfileSource,
  nextConfigSource,
] = await Promise.all([
  readProjectFile("lib/iphone-enrollment-storage.ts"),
  readProjectFile("app/api/public/iphone-enrollment/access/route.ts"),
  readProjectFile("app/api/public/iphone-enrollment/session/route.ts"),
  readProjectFile("app/api/public/iphone-enrollment/cases/route.ts"),
  readProjectFile(
    "app/api/public/iphone-enrollment/cases/approve/route.ts"
  ),
  readProjectFile(
    "app/api/creditos/iphone-enrollment/access-links/route.ts"
  ),
  readProjectFile(
    "app/api/creditos/borradores/[id]/iphone-enrollment/route.ts"
  ),
  readProjectFile("app/api/creditos/borradores/route.ts"),
  readProjectFile("app/api/creditos/route.ts"),
  readProjectFile("app/dashboard/creditos/credit-factory-console.tsx"),
  readProjectFile("app/enrolamiento-iphone/iphone-enrollment-portal.tsx"),
  readProjectFile(
    "app/dashboard/integraciones/enrolamiento-iphone/page.tsx"
  ),
  readProjectFile(
    "app/dashboard/integraciones/enrolamiento-iphone/iphone-enrollment-access-manager.tsx"
  ),
  readProjectFile("app/dashboard/_components/admin-sidebar.tsx"),
  readProjectFile("proxy.ts"),
  readProjectFile("scripts/ensure-iphone-enrollment-schema.mjs"),
  readProjectFile("scripts/railway-predeploy.mjs"),
  readProjectFile("Dockerfile"),
  readProjectFile("next.config.ts"),
]);

function tamperSignedValue(value) {
  const lastCharacter = value.at(-1);
  return value.slice(0, -1) + (lastCharacter === "a" ? "b" : "a");
}

function issueTestSession({
  grantId = testGrantId,
  now = new Date("2026-08-26T15:00:00.000Z"),
  grantExpiresAt = new Date("2026-08-26T17:00:00.000Z"),
  analystName = "Ana Pérez",
  analystExternalId = "ANA-42",
} = {}) {
  return enrollment.issueIphoneEnrollmentPortalSession({
    grantId,
    analyst: {
      name: analystName,
      externalId: analystExternalId,
    },
    grantExpiresAt,
    now,
  });
}

async function expectBodyError(request, maximumBytes, expectedCode) {
  await assert.rejects(
    () =>
      enrollment.readLimitedIphoneEnrollmentJson(request, maximumBytes),
    (error) => {
      assert.equal(error?.name, "IphoneEnrollmentRequestBodyError");
      assert.equal(error?.code, expectedCode);
      return true;
    }
  );
}

test("normaliza cédula, IMEI e identidad administrativa del analista", () => {
  assert.equal(
    enrollment.normalizeIphoneEnrollmentDocument(" 1.083.028.847 "),
    "1083028847"
  );
  assert.equal(enrollment.normalizeIphoneEnrollmentDocument("1234"), null);
  assert.equal(
    enrollment.normalizeIphoneEnrollmentDocument("1".repeat(21)),
    null
  );
  assert.equal(
    enrollment.normalizeIphoneEnrollmentImei("357-113-743-691-552"),
    "357113743691552"
  );
  assert.equal(enrollment.normalizeIphoneEnrollmentImei("35711374369155"), null);
  assert.equal(
    enrollment.normalizeIphoneEnrollmentImei("3571137436915529"),
    null
  );
  assert.equal(
    enrollment.normalizeIphoneEnrollmentAnalystName("  Ana   Pérez  "),
    "Ana Pérez"
  );
  assert.equal(enrollment.normalizeIphoneEnrollmentAnalystName("AB"), null);
  assert.equal(
    enrollment.normalizeIphoneEnrollmentAnalystExternalId("  ANALISTA-42 "),
    "ANALISTA-42"
  );
  assert.equal(enrollment.normalizeIphoneEnrollmentAnalystExternalId("A"), null);
});

test("separa el secreto de sesión del pepper estable y versionado de identidad", () => {
  const configuration = enrollment.getIphoneEnrollmentPortalConfiguration();
  assert.deepEqual(configuration, {
    enabled: true,
    configured: true,
    sessionSecret,
    identityPepper,
    identityKeyVersion,
    sharedAccessSecret,
  });
  assert.equal("accessToken" in configuration, false);
  assert.equal("signingSecret" in configuration, false);
  assert.equal(
    enrollment.getIphoneEnrollmentIdentityKeyVersion(),
    identityKeyVersion
  );
  assert.equal(
    enrollment.getIphoneEnrollmentPortalCookiePath(),
    "/api/public/iphone-enrollment"
  );

  const documentHash = enrollment.hashIphoneEnrollmentDocument("1083028847");
  const imeiHash = enrollment.hashIphoneEnrollmentImei("357113743691552");
  assert.match(documentHash, /^[a-f0-9]{64}$/);
  assert.match(imeiHash, /^[a-f0-9]{64}$/);
  assert.notEqual(documentHash, imeiHash);

  process.env.IPHONE_ENROLLMENT_SESSION_SECRET =
    "rotated-session-secret-for-tests-0123456789abcdef";
  try {
    assert.equal(
      enrollment.hashIphoneEnrollmentDocument("1083028847"),
      documentHash,
      "rotar sesiones no debe invalidar hashes históricos de identidad"
    );
  } finally {
    process.env.IPHONE_ENROLLMENT_SESSION_SECRET = sessionSecret;
  }

  process.env.IPHONE_ENROLLMENT_IDENTITY_PEPPER =
    "rotated-identity-pepper-for-tests-0123456789abcdef";
  try {
    assert.notEqual(
      enrollment.hashIphoneEnrollmentDocument("1083028847"),
      documentHash
    );
  } finally {
    process.env.IPHONE_ENROLLMENT_IDENTITY_PEPPER = identityPepper;
  }

  const grantSecret = enrollment.createIphoneEnrollmentGrantSecret();
  assert.match(grantSecret, /^v1\.[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/);
  assert.equal(
    enrollment.normalizeIphoneEnrollmentGrantSecret(grantSecret),
    grantSecret
  );
  const [grantVersion, grantNonce] = grantSecret.split(".");
  assert.equal(
    enrollment.normalizeIphoneEnrollmentGrantSecret(
      `${grantVersion}.${grantNonce}.${"0".repeat(64)}`
    ),
    null,
    "un token con formato válido pero firma inventada no debe tocar storage"
  );
  assert.match(
    enrollment.hashIphoneEnrollmentGrantToken(grantSecret),
    /^[a-f0-9]{64}$/
  );
  assert.notEqual(
    enrollment.hashIphoneEnrollmentGrantToken(grantSecret),
    grantSecret
  );
});

test("firma sesión con grant e identidad preasignada y rechaza tamper o expiración", () => {
  const session = issueTestSession();
  const verified = enrollment.verifyIphoneEnrollmentPortalSession(
    session.value,
    new Date("2026-08-26T15:01:00.000Z")
  );

  assert.equal(verified?.grantId, testGrantId);
  assert.equal(verified?.accessMode, "GRANT");
  assert.match(verified?.accessFingerprint || "", /^[a-f0-9]{64}$/);
  assert.equal(verified?.analystName, "Ana Pérez");
  assert.equal(verified?.analystExternalId, "ANA-42");
  assert.match(verified?.sessionId || "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.expiresAt.toISOString(), "2026-08-26T17:00:00.000Z");
  assert.equal(
    enrollment.verifyIphoneEnrollmentPortalSession(
      tamperSignedValue(session.value),
      new Date("2026-08-26T15:01:00.000Z")
    ),
    null
  );
  assert.equal(
    enrollment.verifyIphoneEnrollmentPortalSession(
      session.value,
      session.expiresAt
    ),
    null
  );
  assert.throws(
    () =>
      issueTestSession({
        grantExpiresAt: new Date("2026-08-26T15:00:00.000Z"),
      }),
    /IPHONE_ENROLLMENT_GRANT_EXPIRED/
  );
});

test("el acceso compartido es reutilizable, genera sesiones distintas y se revoca al rotar el secreto", () => {
  assert.equal(
    enrollment.iphoneEnrollmentSharedAccessSecretMatches(sharedAccessSecret),
    true
  );
  assert.equal(
    enrollment.iphoneEnrollmentSharedAccessSecretMatches("X".repeat(43)),
    false
  );

  const now = new Date("2026-08-26T15:00:00.000Z");
  const first = enrollment.issueIphoneEnrollmentSharedPortalSession(now);
  const second = enrollment.issueIphoneEnrollmentSharedPortalSession(now);
  const verified = enrollment.verifyIphoneEnrollmentPortalSession(
    first.value,
    new Date("2026-08-26T15:01:00.000Z")
  );
  assert.equal(verified?.accessMode, "SHARED");
  assert.equal(
    verified?.grantId,
    enrollment.IPHONE_ENROLLMENT_SHARED_GRANT_ID
  );
  assert.equal(
    verified?.analystExternalId,
    enrollment.IPHONE_ENROLLMENT_SHARED_ANALYST.externalId
  );
  assert.notEqual(first.value, second.value);

  process.env.IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET = "R".repeat(43);
  try {
    assert.equal(
      enrollment.verifyIphoneEnrollmentPortalSession(
        first.value,
        new Date("2026-08-26T15:01:00.000Z")
      ),
      null
    );
  } finally {
    process.env.IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET = sharedAccessSecret;
  }
});

test("el token de caso queda ligado al grant y a la sesión exacta", () => {
  const issuedAt = new Date("2026-08-26T15:00:00.000Z");
  const session = issueTestSession({ now: issuedAt });
  const documentHash = enrollment.hashIphoneEnrollmentDocument("1083028847");
  const imeiHash = enrollment.hashIphoneEnrollmentImei("357113743691552");
  const token = enrollment.createIphoneEnrollmentCaseToken({
    solicitudId: 387,
    documentHash,
    imeiHash,
    session: session.payload,
    now: issuedAt,
  });
  const verified = enrollment.verifyIphoneEnrollmentCaseToken(
    token,
    new Date("2026-08-26T15:05:00.000Z")
  );

  assert.equal(verified?.solicitudId, 387);
  assert.equal(verified?.targetType, "APPLICATION");
  assert.equal(verified?.targetId, null);
  assert.equal(verified?.documentHash, documentHash);
  assert.equal(verified?.imeiHash, imeiHash);
  assert.equal(verified?.grantId, testGrantId);
  assert.match(verified?.sessionBinding || "", /^[a-f0-9]{64}$/);
  assert.equal(
    enrollment.isIphoneEnrollmentCaseTokenForSession(
      verified,
      session.payload
    ),
    true
  );

  const anotherSession = issueTestSession({ now: issuedAt });
  const anotherGrant = issueTestSession({
    grantId: secondGrantId,
    now: issuedAt,
  });
  assert.equal(
    enrollment.isIphoneEnrollmentCaseTokenForSession(
      verified,
      anotherSession.payload
    ),
    false
  );
  assert.equal(
    enrollment.isIphoneEnrollmentCaseTokenForSession(
      verified,
      anotherGrant.payload
    ),
    false
  );
  assert.equal(
    enrollment.verifyIphoneEnrollmentCaseToken(
      tamperSignedValue(token),
      new Date("2026-08-26T15:05:00.000Z")
    ),
    null
  );
  assert.equal(
    enrollment.verifyIphoneEnrollmentCaseToken(
      token,
      new Date("2026-08-26T15:10:00.000Z")
    ),
    null
  );
});

test("el token de caso vincula un reemplazo posventa exacto", () => {
  const issuedAt = new Date("2026-08-26T15:00:00.000Z");
  const session = issueTestSession({ now: issuedAt });
  const replacementId = "15e689c1-a976-4ce3-b288-301ef2ac34e9";
  const token = enrollment.createIphoneEnrollmentCaseToken({
    solicitudId: 486,
    targetType: "DEVICE_REPLACEMENT",
    targetId: replacementId,
    documentHash: enrollment.hashIphoneEnrollmentDocument("1103740978"),
    imeiHash: enrollment.hashIphoneEnrollmentImei("355063664500617"),
    session: session.payload,
    now: issuedAt,
  });
  const verified = enrollment.verifyIphoneEnrollmentCaseToken(
    token,
    new Date("2026-08-26T15:05:00.000Z")
  );
  assert.equal(verified?.targetType, "DEVICE_REPLACEMENT");
  assert.equal(verified?.targetId, replacementId);
  assert.equal(verified?.solicitudId, 486);
});

test("limita el cuerpo antes de usarlo y distingue media type, tamaño y JSON", async () => {
  const validRequest = new Request(
    "https://finserpay.com/api/public/iphone-enrollment/cases",
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ document: "1083028847", imei: "357113743691552" }),
    }
  );
  assert.deepEqual(
    await enrollment.readLimitedIphoneEnrollmentJson(validRequest),
    { document: "1083028847", imei: "357113743691552" }
  );

  await expectBodyError(
    new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    64,
    "UNSUPPORTED_MEDIA_TYPE"
  );
  await expectBodyError(
    new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "100",
      },
      body: "{}",
    }),
    64,
    "PAYLOAD_TOO_LARGE"
  );
  await expectBodyError(
    new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(100) }),
    }),
    64,
    "PAYLOAD_TOO_LARGE"
  );
  await expectBodyError(
    new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    64,
    "INVALID_JSON"
  );
  await expectBodyError(
    new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    }),
    64,
    "INVALID_JSON"
  );

  assert.deepEqual(
    enrollment.iphoneEnrollmentBodyErrorResponse(
      new enrollment.IphoneEnrollmentRequestBodyError("PAYLOAD_TOO_LARGE")
    ),
    { status: 413, error: "Contenido demasiado grande" }
  );
  assert.equal(enrollment.IPHONE_ENROLLMENT_MAX_BODY_BYTES, 4 * 1024);
});

test("valida origen estricto y construye únicamente el checklist aprobado", () => {
  assert.equal(
    enrollment.isSameOriginIphoneEnrollmentRequest(
      new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
        method: "POST",
        headers: { origin: "https://finserpay.com" },
      })
    ),
    true
  );
  assert.equal(
    enrollment.isSameOriginIphoneEnrollmentRequest(
      new Request(
        "https://railway.internal/api/public/iphone-enrollment/cases",
        {
          method: "POST",
          headers: { origin: "https://finserpay.com" },
        }
      )
    ),
    true
  );
  assert.equal(
    enrollment.isSameOriginIphoneEnrollmentRequest(
      new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    ),
    false
  );
  assert.equal(
    enrollment.isSameOriginIphoneEnrollmentRequest(
      new Request("https://finserpay.com/api/public/iphone-enrollment/cases", {
        method: "POST",
      })
    ),
    false
  );

  const checklist = enrollment.buildIphoneEnrollmentChecklist(true);
  assert.deepEqual(checklist, {
    documentMatched: true,
    imeiMatched: true,
    enrollmentApproved: true,
  });
  assert.equal(enrollment.buildIphoneEnrollmentChecklist(false), null);
  assert.equal(enrollment.buildIphoneEnrollmentChecklist("true"), null);
  assert.match(
    enrollment.hashIphoneEnrollmentChecklist(checklist),
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    enrollment.hashIphoneEnrollmentChecklist({
      enrollmentApproved: true,
      imeiMatched: true,
      documentMatched: true,
    }),
    enrollment.hashIphoneEnrollmentChecklist(checklist),
    "el hash debe ser estable aunque PostgreSQL jsonb reordene las claves"
  );
  assert.match(
    enrollment.IPHONE_ENROLLMENT_RESPONSE_HEADERS["Cache-Control"],
    /no-store/
  );
  assert.equal(
    enrollment.IPHONE_ENROLLMENT_RESPONSE_HEADERS["X-Robots-Tag"],
    "noindex, nofollow, noarchive"
  );
});

test("los grants son de un uso y cada sesión se revalida contra la base", () => {
  assert.match(storageSource, /createIphoneEnrollmentGrantSecret\(\)/);
  assert.match(storageSource, /hashIphoneEnrollmentGrantToken\(token\)/);
  assert.match(storageSource, /FROM "IphoneEnrollmentAccessGrant"/);
  assert.match(
    storageSource,
    /iphone-enrollment-grant:\$\{tokenHash\}[\s\S]*FOR UPDATE/
  );
  assert.match(storageSource, /if \(row\.consumedAt\)/);
  assert.match(storageSource, /"consumedAt" = CURRENT_TIMESTAMP/);
  assert.match(storageSource, /"sessionIdHash" = \$2/);
  assert.match(storageSource, /AND "consumedAt" IS NULL/);
  assert.match(storageSource, /AND "revokedAt" IS NULL/);
  assert.match(storageSource, /AND "expiresAt" > CURRENT_TIMESTAMP/);
  assert.match(
    storageSource,
    /readActiveGrantForSession[\s\S]*"sessionIdHash" = \$2[\s\S]*"sessionExpiresAt" > CURRENT_TIMESTAMP/
  );
  assert.match(
    storageSource,
    /row\.analystName !== session\.analystName/
  );
  assert.match(
    storageSource,
    /row\.analystExternalId !== session\.analystExternalId/
  );

  const serializedGrantStart = storageSource.indexOf("function serializeGrant");
  const serializedGrantEnd = storageSource.indexOf("const GRANT_SELECT");
  const serializedGrantSource = storageSource.slice(
    serializedGrantStart,
    serializedGrantEnd
  );
  assert.doesNotMatch(serializedGrantSource, /tokenHash|sessionIdHash/);
});

test("solo el administrador central obtiene el único acceso compartido", () => {
  assert.match(adminAccessRouteSource, /getSessionUser\(\)/);
  assert.match(adminAccessRouteSource, /isAdminRole\(user\.rolNombre\)/);
  assert.match(
    adminAccessRouteSource,
    /isFinserPayCentralAlly\(user\.aliadoAccesoCodigo\)/
  );
  assert.match(adminAccessRouteSource, /requireCentralAdmin\(\)/g);
  assert.match(
    adminAccessRouteSource,
    /configuration\.sharedAccessSecret/
  );
  assert.match(
    adminAccessRouteSource,
    /const configuration = getIphoneEnrollmentPortalConfiguration\(\)/
  );
  assert.match(
    adminAccessRouteSource,
    /!configuration\.enabled \|\| !configuration\.configured/
  );
  assert.match(adminAccessRouteSource, /IPHONE_ENROLLMENT_NOT_CONFIGURED/);
  assert.match(
    adminAccessRouteSource,
    /reusable: true/
  );
  assert.match(
    adminAccessRouteSource,
    /\/enrolamiento-iphone#acceso=\$\{encodeURIComponent\([\s\S]*configuration\.sharedAccessSecret/
  );
  assert.doesNotMatch(
    adminAccessRouteSource,
    /export async function (?:POST|PATCH|DELETE)/
  );
  assert.doesNotMatch(
    adminAccessRouteSource,
    /createIphoneEnrollmentAccessGrant|revokeIphoneEnrollmentAccessGrant/
  );
  assert.match(adminPageSource, /requireCentralAdminDashboardAccess\(\)/);
  assert.match(adminManagerSource, /Acceso compartido de enrolamiento/);
  assert.match(adminManagerSource, /Enlace único y reutilizable/);
  assert.match(adminManagerSource, /Copiar acceso/);
  assert.doesNotMatch(adminManagerSource, /Generar enlace|Revocar acceso/);
  assert.doesNotMatch(adminManagerSource, /analystName|expiresInMinutes/);
  assert.match(adminPageSource, /No necesita emitir autorizaciones/);
  assert.match(
    sidebarSource,
    /\/dashboard\/integraciones\/enrolamiento-iphone/
  );
});

test("las rutas públicas exigen origen, cuerpo limitado, cookie, acceso y no-store", () => {
  assert.match(
    accessRouteSource,
    /isSameOriginIphoneEnrollmentRequest\(request\)/
  );
  assert.match(accessRouteSource, /readLimitedIphoneEnrollmentJson/);
  assert.match(
    accessRouteSource,
    /exchangeIphoneEnrollmentAccessGrant\(token\)/
  );
  assert.match(
    accessRouteSource,
    /iphoneEnrollmentSharedAccessSecretMatches\(body\.token\)/
  );
  assert.match(
    accessRouteSource,
    /issueIphoneEnrollmentSharedPortalSession\(\)/
  );
  assert.match(accessRouteSource, /SHARED_ACCESS_TOKEN_MAXIMUM = 120/);
  assert.match(storageSource, /"action"\)[\s\S]*VALUES \(\$1, 'ACCESS'\)/);
  assert.match(accessRouteSource, /httpOnly: true/);
  assert.match(accessRouteSource, /sameSite: "strict"/);
  assert.match(
    accessRouteSource,
    /path: getIphoneEnrollmentPortalCookiePath\(\)/
  );
  assert.match(
    accessRouteSource,
    /const token = normalizeIphoneEnrollmentGrantSecret\(body\.token\)/
  );
  assert.match(
    accessRouteSource,
    /consumeInstanceAccessGuard\([\s\S]*hashIphoneEnrollmentGrantToken\(token\)/
  );
  assert.match(accessRouteSource, /ACCESS_TOKEN_MAXIMUM = 8/);
  assert.match(accessRouteSource, /ACCESS_MAX_TRACKED_TOKENS = 2_048/);
  assert.match(
    accessRouteSource,
    /__finserIphoneEnrollmentAccessTokenGuards/
  );
  assert.doesNotMatch(accessRouteSource, /portal-access-global-v1/);
  assert.doesNotMatch(accessRouteSource, /ACCESS_INSTANCE_MAXIMUM/);
  assert.match(accessRouteSource, /consumeIphoneEnrollmentRateLimit/);
  assert.match(accessRouteSource, /action: "ACCESS"/);
  assert.match(
    accessRouteSource,
    /maximum: SHARED_ACCESS_TOKEN_MAXIMUM/
  );
  assert.match(
    storageSource,
    /const accessSubjectHash = hashIphoneEnrollmentRateLimitKey\([\s\S]*"grant",[\s\S]*grant\.id/
  );
  assert.match(
    storageSource,
    /Number\(accessCounts\[0\]\?\.count \|\| 0\) >= 8[\s\S]*"GRANT_RATE_LIMITED"/
  );
  assert.ok(
    accessRouteSource.indexOf("normalizeIphoneEnrollmentGrantSecret(body.token)") <
      accessRouteSource.indexOf("exchangeIphoneEnrollmentAccessGrant(token)"),
    "el formato y la firma deben rechazarse antes del acceso a storage"
  );
  assert.match(
    sessionRouteSource,
    /verifyIphoneEnrollmentPortalSession/
  );
  assert.match(
    sessionRouteSource,
    /validateIphoneEnrollmentPortalSession\(signedSession\)/
  );
  assert.match(
    storageSource,
    /session\.accessMode === "SHARED"[\s\S]*sharedSessionFromPayload\(session\)/
  );

  for (const source of [casesRouteSource, approveRouteSource]) {
    assert.match(source, /isSameOriginIphoneEnrollmentRequest\(request\)/);
    assert.match(
      source,
      /request\.cookies\.get\(getIphoneEnrollmentPortalCookieName\(\)\)/
    );
    assert.match(source, /verifyIphoneEnrollmentPortalSession/);
    assert.match(source, /validateIphoneEnrollmentPortalSession/);
    assert.match(source, /readLimitedIphoneEnrollmentJson/);
    assert.match(source, /consumeIphoneEnrollmentRateLimit/);
    assert.match(source, /Retry-After/);
    assert.match(
      source,
      /headers: \{ \.\.\.IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" \}/
    );
  }
  assert.match(casesRouteSource, /action: "LOOKUP"/);
  assert.match(approveRouteSource, /action: "APPROVE"/);
  assert.match(
    casesRouteSource,
    /hashIphoneEnrollmentRateLimitKey\([\s\S]*"session"/
  );
  assert.match(
    approveRouteSource,
    /hashIphoneEnrollmentRateLimitKey\([\s\S]*"session"/
  );
  assert.match(
    casesRouteSource,
    /grantSession\.accessMode === "SHARED"[\s\S]*"grant",[\s\S]*grantSession\.accessFingerprint[\s\S]*action: "LOOKUP",[\s\S]*maximum: 600/
  );
  assert.match(
    approveRouteSource,
    /grantSession\.accessMode === "SHARED"[\s\S]*"grant",[\s\S]*grantSession\.accessFingerprint[\s\S]*action: "APPROVE",[\s\S]*maximum: 300/
  );
  assert.doesNotMatch(
    [
      accessRouteSource,
      casesRouteSource,
      approveRouteSource,
      adminAccessRouteSource,
    ].join("\n"),
    /\brequest\.json\s*\(/
  );
});

test("el intento durable se confirma antes de rechazar un grant real", () => {
  const attemptStart = storageSource.indexOf(
    "async function persistIphoneEnrollmentAccessAttempt"
  );
  const exchangeStart = storageSource.indexOf(
    "export async function exchangeIphoneEnrollmentAccessGrant"
  );
  assert.ok(attemptStart >= 0 && exchangeStart > attemptStart);

  const attemptSource = storageSource.slice(attemptStart, exchangeStart);
  const missingGrantCheck = attemptSource.indexOf("if (!grant)");
  const cleanup = attemptSource.indexOf(
    "reserveIphoneEnrollmentAttemptCleanup()"
  );
  const insert = attemptSource.indexOf(
    'INSERT INTO "IphoneEnrollmentPortalAttempt"'
  );
  assert.ok(missingGrantCheck >= 0);
  assert.ok(missingGrantCheck < cleanup);
  assert.ok(cleanup < insert);
  assert.doesNotMatch(
    attemptSource.slice(insert),
    /throw new IphoneEnrollmentGrantError/,
    "ningun rechazo de negocio puede revertir el INSERT del intento"
  );

  const readActiveGrantStart = storageSource.indexOf(
    "async function readActiveGrantForSession",
    exchangeStart
  );
  const exchangeSource = storageSource.slice(exchangeStart, readActiveGrantStart);
  const persistAttempt = exchangeSource.indexOf(
    "await persistIphoneEnrollmentAccessAttempt(tokenHash)"
  );
  const exchangeTransaction = exchangeSource.indexOf(
    "return prisma.$transaction(async (transaction) =>"
  );
  const revokedOrExpired = exchangeSource.indexOf("row.revokedAt");
  assert.ok(persistAttempt >= 0);
  assert.ok(persistAttempt < exchangeTransaction);
  assert.ok(exchangeTransaction < revokedOrExpired);
  assert.doesNotMatch(
    exchangeSource.slice(exchangeTransaction),
    /INSERT INTO "IphoneEnrollmentPortalAttempt"/,
    "el INSERT durable no debe compartir la transaccion que puede rechazar el canje"
  );
});

test("el lookup usa cédula e IMEI exactos y una evaluación canónica aprobada", () => {
  assert.match(storageSource, /d\."estado" = 'ABIERTO'/);
  assert.match(storageSource, /d\."creditoId" IS NULL/);
  assert.match(storageSource, /d\."currentStep" >= 5/);
  assert.match(
    storageSource,
    /COALESCE\(d\."expiresAt", d\."createdAt" \+ INTERVAL '15 days'\) > CURRENT_TIMESTAMP/
  );
  assert.match(
    storageSource,
    /UPPER\(COALESCE\(d\."plataforma", ''\)\) = 'IPHONE'/
  );
  assert.match(
    storageSource,
    /INNER JOIN "DataCreditoAssessment" dc[\s\S]*ON dc\."id" = d\."dataCreditoAssessmentId"/
  );
  assert.match(storageSource, /dc\."status" = 'APROBADO'/);
  assert.match(storageSource, /dc\."decision" = 'APROBADO'/);
  assert.match(storageSource, /dc\."platform" = 'IPHONE'/);
  assert.match(storageSource, /dc\."userId" = d\."usuarioId"/);
  assert.match(storageSource, /dc\."sedeId" = d\."sedeId"/);
  assert.match(storageSource, /function authoritativeFirmaSeguroWhere/);
  assert.match(
    storageSource,
    /FROM "FirmaSeguroProcess" firma[\s\S]*firma\."completedAt" IS NOT NULL[\s\S]*firma\."signedDocumentBase64"/
  );
  assert.match(
    storageSource,
    /SELECT latest_firma\."id"[\s\S]*ORDER BY latest_firma\."createdAt" DESC, latest_firma\."id" DESC[\s\S]*LIMIT 1/
  );
  assert.match(
    storageSource,
    /firma\."draftPayload"->>'clienteDocumento'[\s\S]*firma\."draftPayload"->>'imei'/
  );
  assert.match(
    storageSource,
    /function hasAuthorizedVeriffApprovalForEnrollment/
  );
  assert.match(storageSource, /serializeVeriffValidation\(rows\[0\] \|\| null\)/);
  assert.match(storageSource, /validation\.identityDocumentStatus === "match"/);
  assert.match(storageSource, /compareStrictIdentityDocuments/);
  assert.match(
    storageSource,
    /dc\."sellerId" IS NOT DISTINCT FROM d\."vendedorId"/
  );
  assert.match(
    storageSource,
    /dc\."aliadoId" IS NOT DISTINCT FROM aliado\."id"/
  );
  assert.match(
    storageSource,
    /clienteDocumento[\s\S]*= \$1[\s\S]*AND regexp_replace\(COALESCE\(d\."imei"[\s\S]*= \$2[\s\S]*AND dc\."documentHash" = \$3[\s\S]*LIMIT 2/
  );
  assert.match(
    storageSource,
    /hmacDataCreditoValue\("document", input\.document\)/
  );
  assert.match(storageSource, /rows\.length > 1/);
  assert.match(storageSource, /eligibleRows\.length !== 1/);
  assert.match(storageSource, /kind: "AMBIGUOUS"/);
  assert.match(storageSource, /kind: "NOT_READY"/);
  assert.match(storageSource, /kind: "FINALIZED"/);
  assert.match(
    storageSource,
    /d\."estado" = 'ABIERTO'[\s\S]*d\."creditoId" IS NULL[\s\S]*AS "waitingForStepFour"/
  );
  assert.match(
    storageSource,
    /d\."creditoId" IS NOT NULL[\s\S]*d\."closedReason" = 'FINALIZADA'[\s\S]*AS "finalized"/
  );
  assert.match(casesRouteSource, /NOT_READY_FOR_ENROLLMENT/);
  assert.match(casesRouteSource, /CREDIT_ALREADY_FINALIZED/);
  assert.match(
    casesRouteSource,
    /Por seguridad no se modifican créditos históricos/
  );
  assert.doesNotMatch(
    storageSource,
    /payload"->>'dataCreditoStatus'|payload->>'dataCreditoStatus'/
  );
  assert.doesNotMatch(
    storageSource,
    /COALESCE\(dc\."status"[\s\S]{0,100}dataCreditoStatus/
  );
});

test("el DTO público está enmascarado y no expone score, fotos ni finanzas", () => {
  const dtoStart = casesRouteSource.indexOf("const item = result.item");
  const dtoEnd = casesRouteSource.indexOf("} catch (error)", dtoStart);
  assert.ok(dtoStart >= 0 && dtoEnd > dtoStart, "No se encontró el DTO público");
  const dtoSource = casesRouteSource.slice(dtoStart, dtoEnd);

  for (const field of [
    "solicitudNumero",
    "clienteNombre",
    "documento",
    "imei",
    "equipo",
    "sede",
    "aliado",
    "creditDecision",
    "enrollmentStatus",
    "review",
  ]) {
    assert.match(dtoSource, new RegExp("\\b" + field + "\\b"));
  }
  assert.doesNotMatch(
    dtoSource,
    /score|puntaje|foto|selfie|monto|cuota|saldo|financi|telefono|correo|direccion|providerPayload/i
  );
  assert.match(storageSource, /clienteNombre: limitedClientName/);
  assert.match(storageSource, /documentoMasked: maskDocument/);
  assert.match(storageSource, /imeiMasked: maskImei/);
  assert.match(casesRouteSource, /creditDecision: "APROBADA"/);
  assert.match(casesRouteSource, /"ENROLADO_CORRECTAMENTE"/);
  assert.match(casesRouteSource, /"LISTO_PARA_ENROLAR"/);
});

test("la aprobación toma la identidad del acceso y es transaccional e idempotente", () => {
  assert.match(
    approveRouteSource,
    /isIphoneEnrollmentCaseTokenForSession\(caseToken, signedSession\)/
  );
  assert.match(
    approveRouteSource,
    /approveIphoneEnrollmentCase\(\{[\s\S]*caseToken,[\s\S]*grant: grantSession,[\s\S]*checklist/
  );
  assert.doesNotMatch(
    approveRouteSource,
    /analystName\?: unknown|body\.analystName|body\.analystExternalId/
  );

  assert.match(
    storageSource,
    /readActivePortalAccessForSession\([\s\S]*input\.grant\.session,[\s\S]*transaction,[\s\S]*true/
  );
  assert.match(
    storageSource,
    /input\.caseToken\.grantId !== activeGrant\.grantId/
  );
  assert.match(
    storageSource,
    /isIphoneEnrollmentCaseTokenForSession\([\s\S]*input\.caseToken,[\s\S]*activeGrant\.session/
  );
  assert.match(
    storageSource,
    /iphone-enrollment:\$\{input\.caseToken\.solicitudId\}/
  );
  assert.match(storageSource, /FOR UPDATE OF d/);
  assert.match(storageSource, /CASE_IDENTITY_CHANGED/);
  assert.match(
    storageSource,
    /existing\.identityKeyVersion !== getIphoneEnrollmentIdentityKeyVersion\(\)/
  );
  assert.match(
    storageSource,
    /return \{ review: serializeReview\(existing\), alreadyApproved: true \}/
  );
  assert.match(
    storageSource,
    /FROM "IphoneEnrollmentReview"[\s\S]*WHERE "solicitudId" = \$1[\s\S]*AND "supersededAt" IS NULL[\s\S]*LIMIT 1/
  );
  assert.match(
    storageSource,
    /LEFT JOIN "IphoneEnrollmentReview" review[\s\S]*ON review\."solicitudId" = d\."id"[\s\S]*AND review\."supersededAt" IS NULL/
  );
  assert.match(
    storageSource,
    /WHERE review\."solicitudId" = \$1[\s\S]*AND review\."decision" = 'APROBADO'[\s\S]*AND review\."supersededAt" IS NULL/
  );
  const existingReviewCheck = storageSource.indexOf(
    "const existingResult = existingReviewApprovalResult"
  );
  const activeCaseLookup = storageSource.indexOf(
    "const rows = await transaction.$queryRawUnsafe<EnrollmentCaseRow[]>",
    existingReviewCheck
  );
  assert.ok(existingReviewCheck >= 0 && activeCaseLookup > existingReviewCheck);
  assert.match(
    storageSource.slice(existingReviewCheck, activeCaseLookup),
    /pg_advisory_xact_lock\(\$1::integer, \$2::integer\)[\s\S]*FIRMASEGURO_DRAFT_LOCK_NAMESPACE/
  );
  assert.match(storageSource, /INSERT INTO "IphoneEnrollmentReview"/);
  assert.match(storageSource, /activeGrant\.analyst\.name/);
  assert.match(storageSource, /activeGrant\.analyst\.externalId/);
  assert.match(storageSource, /activeGrant\.issuedBy\?\.userId \|\| null/);
  assert.match(storageSource, /activeGrant\.issuedBy\?\.name \|\| null/);
  assert.match(
    storageSource,
    /activeGrant\.accessMode === "GRANT" \? activeGrant\.grantId : null/
  );
  assert.match(
    storageSource,
    /activeGrant\.accessMode === "GRANT"[\s\S]*hashIphoneEnrollmentSharedReviewFingerprint\(\)/
  );
  assert.match(storageSource, /function hasValidReviewAccessProvenance/);
  assert.match(storageSource, /IPHONE_ENROLLMENT_SHARED_ANALYST\.externalId/);
  assert.match(storageSource, /review\."identityKeyVersion" = \$4/);
  assert.match(storageSource, /function hasValidReviewChecklistIntegrity/);
  assert.match(
    storageSource,
    /row\.checklistVersion !== IPHONE_ENROLLMENT_CHECKLIST_VERSION/
  );
  assert.match(
    storageSource,
    /actualKeys\.length !== expectedKeys\.length/
  );
  assert.match(storageSource, /checklist\.documentMatched !== true/);
  assert.match(storageSource, /checklist\.imeiMatched !== true/);
  assert.match(storageSource, /checklist\.enrollmentApproved !== true/);
  assert.match(
    storageSource,
    /row\.checklistHash\.trim\(\) ===[\s\S]*hashIphoneEnrollmentChecklist\(expectedChecklist\)/
  );
  assert.match(
    storageSource,
    /!hasValidReviewChecklistIntegrity\(row\)/
  );
  assert.doesNotMatch(
    schemaSource,
    /CONSTRAINT "IphoneEnrollmentReview_solicitudId_key" UNIQUE \("solicitudId"\)/
  );
  assert.match(
    schemaSource,
    /DROP CONSTRAINT IF EXISTS "IphoneEnrollmentReview_solicitudId_key"/
  );
  assert.match(
    schemaSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS "IphoneEnrollmentReview_active_solicitudId_key"[\s\S]*\("solicitudId"\)[\s\S]*WHERE "supersededAt" IS NULL/
  );
  assert.match(
    schemaSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS "IphoneEnrollmentReview_supersededCorrelationId_key"[\s\S]*\("supersededCorrelationId"\)[\s\S]*WHERE "supersededCorrelationId" IS NOT NULL/
  );
  assert.match(schemaSource, /pg_get_indexdef\(index_state\.indexrelid, 1, true\)/);
  assert.match(schemaSource, /activeReviewIndex\?\.firstColumn\.trim\(\) !== '"solicitudId"'/);
  assert.match(schemaSource, /normalizePredicate\(activeReviewIndex\?\.predicate\) !==[\s\S]*'"supersededAt" IS NULL'/);
  assert.match(schemaSource, /hasGlobalSolicitudUnique/);
  assert.match(storageSource, /pg_get_indexdef\(index_state\.indexrelid, 1, true\)/);
  for (const lifecycleField of [
    "supersededAt",
    "supersededByUserId",
    "supersededByName",
    "supersededReason",
    "supersededCorrelationId",
  ]) {
    assert.match(schemaSource, new RegExp(`"${lifecycleField}"`));
    assert.match(storageSource, new RegExp(`"${lifecycleField}"`));
  }
  assert.match(
    schemaSource,
    /CONSTRAINT "IphoneEnrollmentReview_supersededBy_fkey"[\s\S]*FOREIGN KEY \("supersededByUserId"\)[\s\S]*ON DELETE SET NULL/
  );
  assert.match(
    schemaSource,
    /CONSTRAINT "IphoneEnrollmentReview_correlationId_key" UNIQUE \("correlationId"\)/
  );
});

test("el borrador descarta banderas manuales y el cierre obtiene la revisión server-side", () => {
  assert.match(draftRouteSource, /delete payload\.iphoneEnrolamientoVerificado/);
  assert.match(
    draftRouteSource,
    /delete payload\.iphoneEnrolamientoConfirmadoAt/
  );
  assert.match(draftRouteSource, /delete payload\.iphoneEnrollmentReview/);
  assert.match(draftRouteSource, /delete payload\.iphoneEnrollmentReviewId/);
  assert.match(
    creditRouteSource,
    /getIphoneEnrollmentReviewForSolicitud\(\{[\s\S]*solicitudId: solicitudReservation\.id[\s\S]*document:[\s\S]*imei[\s\S]*\}\)/
  );
  assert.match(creditRouteSource, /iphoneAnalystEnrollmentVerified/);
  assert.match(creditRouteSource, /fuente: "ANALISTA_ENROLAMIENTO"/);
  assert.match(creditRouteSource, /identityKeyVersion:/);
  assert.match(creditRouteSource, /grantId:/);
  assert.doesNotMatch(
    creditRouteSource,
    /Boolean\(body\.iphoneEnrolamientoVerificado\)/
  );
  assert.doesNotMatch(
    creditRouteSource,
    /toNullableDate\(body\.iphoneEnrolamientoConfirmadoAt\)/
  );
  assert.match(sellerStatusRouteSource, /getIphoneEnrollmentReviewForSolicitud/);
  assert.match(sellerStatusRouteSource, /getSessionUser/);

  const sellerProjectionStart = sellerStatusRouteSource.indexOf(
    "review: review"
  );
  const sellerProjectionEnd = sellerStatusRouteSource.indexOf(
    "200",
    sellerProjectionStart
  );
  assert.ok(
    sellerProjectionStart >= 0 && sellerProjectionEnd > sellerProjectionStart,
    "No se encontró la proyección mínima al asesor"
  );
  const sellerProjection = sellerStatusRouteSource.slice(
    sellerProjectionStart,
    sellerProjectionEnd
  );
  for (const field of [
    "id",
    "decision",
    "analystName",
    "approvedAt",
  ]) {
    assert.match(sellerProjection, new RegExp("\\b" + field + "\\b"));
  }
  assert.doesNotMatch(
    sellerProjection,
    /analystExternalId|checklistVersion|checklistHash|checklist:|documentHash|imeiHash|grantId|grantIssuedBy|accessFingerprint|correlationId|identityKeyVersion/
  );
});

test("la fábrica sincroniza el resultado y el portal usa un acceso compartido sin autorizaciones individuales", () => {
  assert.doesNotMatch(
    factorySource,
    /Confirmo que el equipo est[aá] enrolado|aria-label="Confirmo que el equipo está enrolado"/
  );
  assert.doesNotMatch(
    factorySource,
    /onChange=\{\(event\)[\s\S]{0,400}setIphoneEnrollmentVerified/
  );
  assert.match(
    factorySource,
    /\/api\/creditos\/borradores\/\$\{draftId\}\/iphone-enrollment/
  );
  assert.match(factorySource, /window\.setInterval/);
  assert.match(factorySource, /8_000/);
  assert.match(factorySource, /window\.clearInterval\(intervalId\)/);
  assert.match(factorySource, /iphoneEnrollmentReview\.analystName/);
  assert.match(factorySource, /iphoneEnrollmentReview\.approvedAt/);
  assert.match(factorySource, /El asesor no puede marcar este control/);
  assert.match(factorySource, /iphoneFactory && nextStep === 5 && draftId/);
  assert.match(
    factorySource,
    /await saveDraftPayloadForVeriff\(\s*factoryDraftPayload,\s*nextStep,\s*draftId\s*\)/
  );

  assert.match(portalSource, /fragment\.get\("acceso"\)/);
  assert.match(portalSource, /window\.history\.replaceState/);
  assert.match(portalSource, /setAnalyst\(data\.analyst\)/);
  assert.doesNotMatch(portalSource, /setAnalystName|setAnalystExternalId/);
  assert.doesNotMatch(portalSource, /\{analyst\.name\}|\{analyst\.externalId\}/);
  assert.match(portalSource, /Acceso de especialistas activo/);
  assert.match(portalSource, /inputMode="numeric"/);
  assert.match(portalSource, /Aprobada/);
  assert.match(portalSource, /Solo falta enrolar/);
  assert.match(portalSource, /La venta llegó al paso 4/);
  assert.match(portalSource, /ENROLADO CORRECTAMENTE/);
  assert.match(portalSource, /import ConfirmDialog/);
  assert.match(
    portalSource,
    /confirmLabel="Confirmar ENROLADO CORRECTAMENTE"/
  );

  const approvalRequestStart = portalSource.indexOf(
    "/api/public/iphone-enrollment/cases/approve"
  );
  const approvalRequestEnd = portalSource.indexOf(
    "const data = await readJson(response)",
    approvalRequestStart
  );
  const approvalRequest = portalSource.slice(
    approvalRequestStart,
    approvalRequestEnd
  );
  assert.match(approvalRequest, /caseToken/);
  assert.match(approvalRequest, /enrollmentApproved: true/);
  assert.doesNotMatch(approvalRequest, /analystName|analystExternalId/);
});

test("la aprobación confirmada abre un resumen modal accesible y responsive", () => {
  const approvalResponseStart = portalSource.indexOf(
    "const data = await readJson(response)",
    portalSource.indexOf("/api/public/iphone-enrollment/cases/approve")
  );
  const approvalResponseEnd = portalSource.indexOf("} catch", approvalResponseStart);
  const approvalResponse = portalSource.slice(
    approvalResponseStart,
    approvalResponseEnd
  );

  assert.ok(approvalResponseStart >= 0 && approvalResponseEnd > approvalResponseStart);
  assert.ok(
    approvalResponse.indexOf("if (!response.ok || !data.review)") <
      approvalResponse.indexOf("setSuccessOpen(true)")
  );
  assert.match(portalSource, /role="dialog"/);
  assert.match(portalSource, /aria-modal="true"/);
  assert.match(portalSource, /createPortal\(/);
  assert.match(portalSource, /fp-ui-dialog-backdrop/);
  assert.match(portalSource, /iphone-enrollment-success-title/);
  assert.match(portalSource, /iphone-enrollment-success-description/);
  assert.match(portalSource, /document\.body\.style\.overflow = "hidden"/);
  assert.match(portalSource, /event\.key === "Escape"/);
  assert.match(portalSource, /event\.key !== "Tab"/);
  assert.match(portalSource, /backdrop-blur-sm/);
  assert.match(portalSource, /max-w-\[560px\]/);
  assert.match(portalSource, /max-h-\[calc\(100dvh-2\.5rem\)\]/);
  assert.match(portalSource, /overscroll-contain/);
  assert.match(portalSource, /sm:grid-cols-2/);
  assert.match(portalSource, /ENROLADO CORRECTAMENTE/);
  assert.match(portalSource, /¡Dispositivo protegido!/);
  for (const label of ["Cliente", "Cédula", "IMEI", "Referencia", "Fecha y hora"]) {
    assert.match(portalSource, new RegExp(`label="${label}"`));
  }
  assert.match(portalSource, /value=\{item\.clienteNombre\}/);
  assert.match(portalSource, /value=\{formatDocument\(documentValue\)\}/);
  assert.match(portalSource, /value=\{imeiValue\}/);
  assert.match(portalSource, /value=\{item\.equipo\}/);
  assert.match(portalSource, /formatDateTime\(review\.approvedAt\)/);
  assert.match(portalSource, />\s*Finalizar\s*</);
  assert.match(portalSource, />\s*Consultar otra solicitud\s*</);
  assert.match(portalSource, /setDocument\(""\)/);
  assert.match(portalSource, /setImei\(""\)/);
});

test("el módulo no dispara una nueva consulta externa a DataCrédito", () => {
  const serverSources = [
    storageSource,
    accessRouteSource,
    sessionRouteSource,
    casesRouteSource,
    approveRouteSource,
    sellerStatusRouteSource,
  ].join("\n");
  assert.doesNotMatch(serverSources, /\/api\/creditos\/datacredito/i);
  assert.doesNotMatch(serverSources, /\bfetch\s*\(/);
  assert.doesNotMatch(serverSources, /consultarDataCredito|requestDataCredito/i);
  assert.match(storageSource, /INNER JOIN "DataCreditoAssessment" dc/);
});

test("el proxy limita el prefijo y la página pública aplica CSP anti-embebido", () => {
  assert.match(proxySource, /"\/api\/public\/iphone-enrollment"/);
  assert.match(proxySource, /pathname === prefix/);
  assert.match(proxySource, /pathname\.startsWith/);
  assert.match(proxySource, /prefix\.endsWith/);
  assert.doesNotMatch(proxySource, /"\/api\/public"\s*,/);

  assert.match(nextConfigSource, /source: "\/enrolamiento-iphone"/);
  assert.match(nextConfigSource, /key: "Content-Security-Policy"/);
  assert.match(nextConfigSource, /default-src 'self'/);
  assert.match(nextConfigSource, /connect-src 'self'/);
  assert.match(nextConfigSource, /frame-ancestors 'none'/);
  assert.match(nextConfigSource, /object-src 'none'/);
  assert.match(nextConfigSource, /key: "X-Frame-Options", value: "DENY"/);
  assert.match(nextConfigSource, /key: "Referrer-Policy", value: "no-referrer"/);
  assert.match(nextConfigSource, /no-cache, no-store, must-revalidate/);
});

test("Railway crea y verifica grants, revisiones y rate limit antes de iniciar", () => {
  assert.match(
    schemaSource,
    /CREATE TABLE IF NOT EXISTS public\."IphoneEnrollmentAccessGrant"/
  );
  assert.match(
    schemaSource,
    /CONSTRAINT "IphoneEnrollmentAccessGrant_tokenHash_key" UNIQUE \("tokenHash"\)/
  );
  assert.match(
    schemaSource,
    /"expiresAt" <= "createdAt" \+ INTERVAL '8 hours'/
  );
  assert.match(
    schemaSource,
    /"consumedAt" IS NOT NULL AND "sessionIdHash" IS NOT NULL AND "sessionExpiresAt" IS NOT NULL/
  );
  assert.match(
    schemaSource,
    /CREATE UNIQUE INDEX IF NOT EXISTS "IphoneEnrollmentAccessGrant_sessionIdHash_key"/
  );
  assert.match(
    schemaSource,
    /FOREIGN KEY \("grantId"\)[\s\S]*REFERENCES public\."IphoneEnrollmentAccessGrant" \("id"\)[\s\S]*ON DELETE RESTRICT/
  );
  assert.match(schemaSource, /"identityKeyVersion" TEXT NOT NULL/);
  assert.match(
    schemaSource,
    /CREATE TABLE IF NOT EXISTS public\."IphoneEnrollmentPortalAttempt"/
  );
  assert.match(schemaSource, /SET LOCAL lock_timeout = '10s'/);
  assert.match(schemaSource, /SET LOCAL statement_timeout = '120s'/);
  assert.match(schemaSource, /assertCompatibleColumns\(\)/);
  assert.match(schemaSource, /assertCompatibleIndexes\(\)/);
  assert.match(schemaSource, /assertCompatibleConstraints\(\)/);
  assert.match(schemaSource, /async function assertNoLegacyReviews\(\)/);
  assert.match(schemaSource, /"grantId" IS NULL/);
  assert.match(schemaSource, /"analystName" = \$1/);
  assert.match(schemaSource, /"analystExternalId" = \$2/);
  assert.match(
    schemaSource,
    /BTRIM\("accessFingerprint"\) = \$3/
  );
  assert.match(schemaSource, /"identityKeyVersion" = \$4/);
  assert.match(
    schemaSource,
    /createHmac\("sha256", identityPepper\)[\s\S]*shared-review/
  );
  assert.match(
    schemaSource,
    /LOWER\(COALESCE\("identityKeyVersion", ''\)\) = 'legacy'/
  );
  assert.match(schemaSource, /IPHONE_ENROLLMENT_LEGACY_REVIEWS/);
  assert.match(
    schemaSource,
    /await assertCompatibleConstraints\(\);[\s\S]*await assertNoLegacyReviews\(\);/
  );
  assert.doesNotMatch(
    schemaSource,
    /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i
  );
  assert.match(
    predeploySource,
    /import\("\.\/ensure-iphone-enrollment-schema\.mjs"\)/
  );
  assert.match(
    dockerfileSource,
    /COPY --from=builder \/app\/scripts\/ensure-iphone-enrollment-schema\.mjs \.\/scripts\/ensure-iphone-enrollment-schema\.mjs/
  );
});
