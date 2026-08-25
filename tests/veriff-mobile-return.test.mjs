import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildVeriffCompletionUrl,
  VERIFF_COMPLETION_PATH,
} from "../lib/veriff-callback.ts";
import {
  normalizeIdentityDocumentNumber,
  veriffIdentityMatchesExpectedDocument,
} from "../lib/veriff-identity.ts";

const veriffRoute = readFileSync(
  new URL("../app/api/creditos/veriff/route.ts", import.meta.url),
  "utf8"
);
const factoryConsole = readFileSync(
  new URL(
    "../app/dashboard/creditos/credit-factory-console.tsx",
    import.meta.url
  ),
  "utf8"
);
const completionPage = readFileSync(
  new URL(
    "../app/validacion-identidad/completada/page.tsx",
    import.meta.url
  ),
  "utf8"
);
const deploymentGuide = readFileSync(
  new URL("../DEPLOYMENT-RAILWAY.md", import.meta.url),
  "utf8"
);

function sourceBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("el callback de Veriff siempre termina en una pantalla pública", () => {
  const configured = buildVeriffCompletionUrl(
    new Request("http://localhost:3000/api/creditos/veriff"),
    { NEXT_PUBLIC_APP_URL: "https://finserpay.com/" }
  );
  const forwarded = buildVeriffCompletionUrl(
    new Request("http://internal:3000/api/creditos/veriff", {
      headers: {
        host: "internal:3000",
        "x-forwarded-host": "ventas.finserpay.com",
        "x-forwarded-proto": "https",
      },
    }),
    {}
  );

  assert.equal(VERIFF_COMPLETION_PATH, "/validacion-identidad/completada");
  assert.equal(
    configured,
    "https://finserpay.com/validacion-identidad/completada"
  );
  assert.equal(
    forwarded,
    "https://ventas.finserpay.com/validacion-identidad/completada"
  );
  assert.doesNotMatch(configured, /\/dashboard|\/login/);
});

test("la creación de la sesión sobreescribe cualquier callback administrativo antiguo", () => {
  assert.match(
    veriffRoute,
    /callbackUrl:\s*buildVeriffCompletionUrl\(request\)/
  );
  assert.match(completionPage, /Ya puedes cerrar esta pestaña y volver con el asesor/);
  assert.match(completionPage, /No necesitas iniciar sesión en este celular/);
  assert.doesNotMatch(
    deploymentGuide,
    /VERIFF_CALLBACK_URL=https:\/\/finserpay\.com\/dashboard/
  );
});

test("la identidad conserva los campos ancla de DataCrédito y no reinicia el asistente", () => {
  assert.equal(normalizeIdentityDocumentNumber("1.110.178.524"), "1110178524");
  assert.equal(
    veriffIdentityMatchesExpectedDocument("1.110.178.524", "1110178524"),
    true
  );
  assert.equal(
    veriffIdentityMatchesExpectedDocument("999999999", "1110178524"),
    false
  );
  assert.equal(veriffIdentityMatchesExpectedDocument(null, "1110178524"), true);

  const applyIdentity = sourceBlock(
    factoryConsole,
    "const applyVeriffIdentityData",
    "const veriffMissingIdentityMessage"
  );

  assert.match(applyIdentity, /const dataCreditoIdentityLocked = Boolean\(dataCreditoApproval\)/);
  assert.match(applyIdentity, /lastName && !dataCreditoIdentityLocked/);
  assert.match(applyIdentity, /documentNumber && !dataCreditoIdentityLocked/);
  assert.match(applyIdentity, /identity\.documentType && !dataCreditoIdentityLocked/);
  assert.doesNotMatch(applyIdentity, /setWizardStep\(1\)/);
  assert.doesNotMatch(
    factoryConsole,
    /veriffApprovalCanUnlockClient\(\s*veriffValidation,\s*veriffExpectedDraftId\s*\)/
  );
  assert.doesNotMatch(
    factoryConsole,
    /veriffApprovalCanUnlockClient\(\s*validation,\s*veriffExpectedDraftId\s*\)/
  );
});
