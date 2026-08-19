import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "lib/datacredito/secure-record.ts");
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "finserpay-datacredito-secure-record-")
);
const importablePath = path.join(temporaryDirectory, "secure-record.ts");
const source = await readFile(sourcePath, "utf8");

await writeFile(
  importablePath,
  source.replace(/^import "server-only";\s*/, ""),
  "utf8"
);

const jiti = createJiti(import.meta.url);
const {
  DATA_CREDITO_SECURE_RECORD_ALGORITHM,
  DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES,
  DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES,
  DATA_CREDITO_SECURE_RECORD_NONCE_BYTES,
  DataCreditoSecureRecordConfigurationError,
  DataCreditoSecureRecordDecryptionError,
  DataCreditoSecureRecordValidationError,
  assertDataCreditoSecureRecordConfigured,
  decryptDataCreditoSecureRecord,
  encryptDataCreditoSecureRecord,
} = await jiti.import(importablePath);

after(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

const ASSESSMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "987e6543-e21b-42d3-a456-426614174111";
const OTHER_ASSESSMENT_ID = "123e4567-e89b-42d3-a456-426614174999";
const OTHER_CORRELATION_ID = "987e6543-e21b-42d3-a456-426614174888";

const keyBase64 = (fill) => Buffer.alloc(32, fill).toString("base64");
const KEY_V1 = keyBase64(0x11);
const KEY_V2 = keyBase64(0x22);

function encryptionEnv({ activeKeyId = "v1", keys = { v1: KEY_V1 } } = {}) {
  return {
    DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID: activeKeyId,
    DATACREDITO_RECORD_ENCRYPTION_KEYS_JSON: JSON.stringify(keys),
  };
}

function recordInput(overrides = {}) {
  return {
    assessmentId: ASSESSMENT_ID,
    correlationId: CORRELATION_ID,
    documentNumber: "1110178524",
    firstSurname: "GARCIA",
    providerPayload: {
      status: "ACCEPTED",
      content: {
        respuesta: {
          comportamientoCrediticio: {
            comportamientoPago: { moraActual: 0 },
          },
          informacionRiesgo: { conInformacion: true, score: "853" },
          telecomunicaciones: { lineasActivas: 2 },
        },
      },
    },
    ...overrides,
  };
}

function decryptInput(envelope, overrides = {}) {
  return {
    assessmentId: ASSESSMENT_ID,
    correlationId: CORRELATION_ID,
    ...envelope,
    ...overrides,
  };
}

function tamperedBuffer(value, position = 0) {
  const copy = Buffer.from(value);
  copy[position] ^= 0x01;
  return copy;
}

function isConfigurationError(error) {
  return error instanceof DataCreditoSecureRecordConfigurationError;
}

function isValidationError(error) {
  return error instanceof DataCreditoSecureRecordValidationError;
}

function isDecryptionError(error) {
  return error instanceof DataCreditoSecureRecordDecryptionError;
}

test("valida un keyring AES-256 separado y no retorna las claves", () => {
  assert.equal(
    assertDataCreditoSecureRecordConfigured(
      encryptionEnv({ keys: { v1: KEY_V1, v2: KEY_V2 } })
    ),
    undefined
  );

  const invalidCases = [
    {},
    {
      DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID: "v1",
      DATACREDITO_RECORD_ENCRYPTION_KEYS_JSON: "no-json",
    },
    encryptionEnv({ activeKeyId: "missing" }),
    encryptionEnv({ keys: { v1: Buffer.alloc(31).toString("base64") } }),
    encryptionEnv({ keys: { "id no valido": KEY_V1 } }),
  ];

  for (const env of invalidCases) {
    assert.throws(
      () => assertDataCreditoSecureRecordConfigured(env),
      isConfigurationError
    );
  }
});

test("cifra y descifra el expediente completo con nonce y tag GCM correctos", () => {
  const env = encryptionEnv();
  const input = recordInput();
  const envelope = encryptDataCreditoSecureRecord(input, env);

  assert.equal(envelope.algorithm, DATA_CREDITO_SECURE_RECORD_ALGORITHM);
  assert.equal(envelope.keyId, "v1");
  assert.equal(envelope.aadVersion, 1);
  assert.equal(envelope.plaintextVersion, 1);
  assert.equal(envelope.nonce.length, DATA_CREDITO_SECURE_RECORD_NONCE_BYTES);
  assert.equal(envelope.authTag.length, DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES);
  assert.equal(envelope.ciphertext.length, envelope.plaintextBytes);
  assert.ok(envelope.plaintextBytes > 0);
  assert.doesNotMatch(envelope.ciphertext.toString("utf8"), /1110178524|GARCIA/);
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(KEY_V1));

  assert.deepEqual(decryptDataCreditoSecureRecord(decryptInput(envelope), env), {
    version: 1,
    documentNumber: input.documentNumber,
    firstSurname: input.firstSurname,
    providerPayload: input.providerPayload,
  });
});

test("AAD impide mover un expediente entre evaluaciones o correlaciones", () => {
  const env = encryptionEnv();
  const envelope = encryptDataCreditoSecureRecord(recordInput(), env);

  assert.throws(
    () =>
      decryptDataCreditoSecureRecord(
        decryptInput(envelope, { assessmentId: OTHER_ASSESSMENT_ID }),
        env
      ),
    isDecryptionError
  );
  assert.throws(
    () =>
      decryptDataCreditoSecureRecord(
        decryptInput(envelope, { correlationId: OTHER_CORRELATION_ID }),
        env
      ),
    isDecryptionError
  );
});

test("falla cerrado ante manipulacion del sobre o una clave incorrecta", () => {
  const env = encryptionEnv();
  const envelope = encryptDataCreditoSecureRecord(recordInput(), env);
  const tamperedCases = [
    { ciphertext: tamperedBuffer(envelope.ciphertext) },
    { nonce: tamperedBuffer(envelope.nonce) },
    { authTag: tamperedBuffer(envelope.authTag) },
    { plaintextBytes: envelope.plaintextBytes - 1 },
    { algorithm: "AES-128-GCM" },
    { aadVersion: 2 },
    { plaintextVersion: 2 },
    { keyId: "missing" },
  ];

  for (const tamper of tamperedCases) {
    assert.throws(
      () =>
        decryptDataCreditoSecureRecord(
          decryptInput(envelope, tamper),
          env
        ),
      isDecryptionError
    );
  }

  assert.throws(
    () =>
      decryptDataCreditoSecureRecord(
        decryptInput(envelope),
        encryptionEnv({ keys: { v1: KEY_V2 } })
      ),
    isDecryptionError
  );
});

test("rota la clave activa y conserva lectura mientras exista la version anterior", () => {
  const bothKeysV1Active = encryptionEnv({
    activeKeyId: "v1",
    keys: { v1: KEY_V1, v2: KEY_V2 },
  });
  const bothKeysV2Active = encryptionEnv({
    activeKeyId: "v2",
    keys: { v1: KEY_V1, v2: KEY_V2 },
  });
  const oldEnvelope = encryptDataCreditoSecureRecord(
    recordInput(),
    bothKeysV1Active
  );
  const newEnvelope = encryptDataCreditoSecureRecord(
    recordInput({ documentNumber: "1000000000" }),
    bothKeysV2Active
  );

  assert.equal(oldEnvelope.keyId, "v1");
  assert.equal(newEnvelope.keyId, "v2");
  assert.equal(
    decryptDataCreditoSecureRecord(
      decryptInput(oldEnvelope),
      bothKeysV2Active
    ).documentNumber,
    "1110178524"
  );
  assert.equal(
    decryptDataCreditoSecureRecord(
      decryptInput(newEnvelope),
      bothKeysV2Active
    ).documentNumber,
    "1000000000"
  );
  assert.throws(
    () =>
      decryptDataCreditoSecureRecord(
        decryptInput(oldEnvelope),
        encryptionEnv({ activeKeyId: "v2", keys: { v2: KEY_V2 } })
      ),
    isDecryptionError
  );
});

test("cada cifrado usa un nonce distinto aun para el mismo registro", () => {
  const env = encryptionEnv();
  const nonces = new Set();

  for (let index = 0; index < 32; index += 1) {
    const envelope = encryptDataCreditoSecureRecord(recordInput(), env);
    nonces.add(envelope.nonce.toString("base64"));
  }

  assert.equal(nonces.size, 32);
});

test("rechaza PII, contextos y payloads no serializables antes de cifrar", () => {
  const env = encryptionEnv();
  const cyclic = {};
  cyclic.self = cyclic;

  const invalidInputs = [
    recordInput({ assessmentId: "no-uuid" }),
    recordInput({ correlationId: "no-uuid" }),
    recordInput({ documentNumber: "111.017.852" }),
    recordInput({ firstSurname: "" }),
    recordInput({ providerPayload: [] }),
    recordInput({ providerPayload: { invalid: undefined } }),
    recordInput({ providerPayload: { invalid: 1n } }),
    recordInput({ providerPayload: cyclic }),
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => encryptDataCreditoSecureRecord(input, env),
      isValidationError
    );
  }
});

test("impone limite de plaintext y de ciphertext antes de descifrar", () => {
  const env = encryptionEnv();
  const oversizedPayload = {
    data: "x".repeat(DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES),
  };

  assert.throws(
    () =>
      encryptDataCreditoSecureRecord(
        recordInput({ providerPayload: oversizedPayload }),
        env
      ),
    isValidationError
  );

  const envelope = encryptDataCreditoSecureRecord(recordInput(), env);
  assert.throws(
    () =>
      decryptDataCreditoSecureRecord(
        decryptInput(envelope, {
          ciphertext: Buffer.alloc(
            DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES + 1
          ),
          plaintextBytes: DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES + 1,
        }),
        env
      ),
    isDecryptionError
  );
});
