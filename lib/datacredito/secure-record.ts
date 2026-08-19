import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ENCRYPTION_KEYS_ENV = "DATACREDITO_RECORD_ENCRYPTION_KEYS_JSON";
const ACTIVE_KEY_ID_ENV = "DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID";
const NODE_CIPHER = "aes-256-gcm";
const SECURE_RECORD_PURPOSE = "FINSERPAY_DATACREDITO_MIDECISOR_RECORD";

export const DATA_CREDITO_SECURE_RECORD_ALGORITHM = "AES-256-GCM" as const;
export const DATA_CREDITO_SECURE_RECORD_AAD_VERSION = 1 as const;
export const DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION = 1 as const;
export const DATA_CREDITO_SECURE_RECORD_NONCE_BYTES = 12;
export const DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES = 16;
export const DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES = 6 * 1024 * 1024;

const ENCRYPTION_KEY_BYTES = 32;
const MAX_CONFIGURED_KEYS = 32;
const MAX_KEYRING_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 250_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

type EncryptionConfig = {
  activeKeyId: string;
  keys: Map<string, Buffer>;
};

export type DataCreditoSecureRecord = {
  version: typeof DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION;
  documentNumber: string;
  firstSurname: string;
  providerPayload: unknown;
};

export type DataCreditoSecureRecordEnvelope = {
  algorithm: typeof DATA_CREDITO_SECURE_RECORD_ALGORITHM;
  keyId: string;
  aadVersion: typeof DATA_CREDITO_SECURE_RECORD_AAD_VERSION;
  plaintextVersion: typeof DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  plaintextBytes: number;
};

export type EncryptDataCreditoSecureRecordInput = {
  assessmentId: string;
  correlationId: string;
  documentNumber: string;
  firstSurname: string;
  providerPayload: unknown;
};

export type DecryptDataCreditoSecureRecordInput = {
  assessmentId: string;
  correlationId: string;
  algorithm: string;
  keyId: string;
  aadVersion: number;
  plaintextVersion: number;
  nonce: Buffer | Uint8Array;
  authTag: Buffer | Uint8Array;
  ciphertext: Buffer | Uint8Array;
  plaintextBytes: number;
};

export class DataCreditoSecureRecordConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataCreditoSecureRecordConfigurationError";
  }
}

export class DataCreditoSecureRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataCreditoSecureRecordValidationError";
  }
}

export class DataCreditoSecureRecordDecryptionError extends Error {
  constructor() {
    super("No se pudo descifrar el expediente de DataCredito.");
    this.name = "DataCreditoSecureRecordDecryptionError";
  }
}

function configurationError(message: string): never {
  throw new DataCreditoSecureRecordConfigurationError(message);
}

function validationError(message: string): never {
  throw new DataCreditoSecureRecordValidationError(message);
}

function disposeEncryptionConfig(config: EncryptionConfig | null) {
  if (!config) return;

  for (const key of config.keys.values()) {
    key.fill(0);
  }
  config.keys.clear();
}

function decodeEncryptionKey(keyId: string, value: unknown) {
  if (typeof value !== "string") {
    configurationError(`La clave ${keyId} debe estar codificada en base64.`);
  }

  const encoded = value.trim();
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    configurationError(`La clave ${keyId} no tiene un base64 valido.`);
  }

  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== ENCRYPTION_KEY_BYTES ||
    key.toString("base64") !== encoded
  ) {
    key.fill(0);
    configurationError(`La clave ${keyId} debe contener exactamente 32 bytes.`);
  }

  return key;
}

function readEncryptionConfig(env: EnvironmentSource): EncryptionConfig {
  const rawKeyring = String(env[ENCRYPTION_KEYS_ENV] || "").trim();
  const activeKeyId = String(env[ACTIVE_KEY_ID_ENV] || "").trim();

  if (!rawKeyring) {
    configurationError(`${ENCRYPTION_KEYS_ENV} no esta configurada.`);
  }
  if (Buffer.byteLength(rawKeyring, "utf8") > MAX_KEYRING_JSON_BYTES) {
    configurationError(`${ENCRYPTION_KEYS_ENV} excede el tamano permitido.`);
  }
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    configurationError(`${ACTIVE_KEY_ID_ENV} no contiene un identificador valido.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeyring) as unknown;
  } catch {
    configurationError(`${ENCRYPTION_KEYS_ENV} no contiene JSON valido.`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    configurationError(`${ENCRYPTION_KEYS_ENV} debe ser un objeto JSON.`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  const entries = Object.entries(descriptors);
  if (!entries.length || entries.length > MAX_CONFIGURED_KEYS) {
    configurationError(
      `${ENCRYPTION_KEYS_ENV} debe contener entre 1 y ${MAX_CONFIGURED_KEYS} claves.`
    );
  }

  const keys = new Map<string, Buffer>();
  try {
    for (const [keyId, descriptor] of entries) {
      if (!KEY_ID_PATTERN.test(keyId) || !("value" in descriptor)) {
        configurationError(`${ENCRYPTION_KEYS_ENV} contiene una clave invalida.`);
      }
      keys.set(keyId, decodeEncryptionKey(keyId, descriptor.value));
    }

    if (!keys.has(activeKeyId)) {
      configurationError(
        `${ACTIVE_KEY_ID_ENV} no existe en ${ENCRYPTION_KEYS_ENV}.`
      );
    }

    return { activeKeyId, keys };
  } catch (error) {
    for (const key of keys.values()) {
      key.fill(0);
    }
    keys.clear();
    throw error;
  }
}

export function assertDataCreditoSecureRecordConfigured(
  env: EnvironmentSource = process.env
) {
  const config = readEncryptionConfig(env);
  disposeEncryptionConfig(config);
}

function validatedUuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    validationError(`${field} no es un UUID valido.`);
  }
  return value.toLowerCase();
}

function validatedDocumentNumber(value: unknown) {
  if (typeof value !== "string" || !/^\d{3,13}$/.test(value)) {
    validationError("El numero de documento no es valido.");
  }
  return value;
}

function validatedFirstSurname(value: unknown) {
  if (typeof value !== "string") {
    validationError("El primer apellido no es valido.");
  }

  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    !/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u.test(normalized)
  ) {
    validationError("El primer apellido no es valido.");
  }
  return normalized;
}

function assertJsonValue(value: unknown) {
  let nodes = 0;

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      validationError("El expediente excede la complejidad permitida.");
    }

    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }

    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        validationError("El expediente contiene un numero no valido.");
      }
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item, depth + 1);
      }
      return;
    }

    if (typeof current !== "object") {
      validationError("El expediente contiene un valor no serializable.");
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      validationError("El expediente contiene un objeto no serializable.");
    }
    if (Object.getOwnPropertySymbols(current).length) {
      validationError("El expediente contiene propiedades no serializables.");
    }

    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(current)
    )) {
      if (
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        !("value" in descriptor)
      ) {
        validationError("El expediente contiene una propiedad no permitida.");
      }
      visit(descriptor.value, depth + 1);
    }
  };

  visit(value, 0);
}

function validatedProviderPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validationError("El expediente de DataCredito debe ser un objeto JSON.");
  }
  assertJsonValue(value);
  return value;
}

function buildAad(input: {
  assessmentId: string;
  correlationId: string;
  keyId: string;
  aadVersion: number;
  plaintextVersion: number;
}) {
  return Buffer.from(
    JSON.stringify([
      SECURE_RECORD_PURPOSE,
      input.aadVersion,
      input.plaintextVersion,
      input.assessmentId,
      input.correlationId,
      input.keyId,
    ]),
    "utf8"
  );
}

function assertPlaintextSize(plaintextBytes: number) {
  if (
    !Number.isSafeInteger(plaintextBytes) ||
    plaintextBytes <= 0 ||
    plaintextBytes > DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES
  ) {
    validationError("El expediente excede el tamano cifrable permitido.");
  }
}

function envelopeBuffer(value: unknown, expectedBytes?: number) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new DataCreditoSecureRecordDecryptionError();
  }

  const buffer = Buffer.from(value);
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    buffer.fill(0);
    throw new DataCreditoSecureRecordDecryptionError();
  }
  return buffer;
}

export function encryptDataCreditoSecureRecord(
  input: EncryptDataCreditoSecureRecordInput,
  env: EnvironmentSource = process.env
): DataCreditoSecureRecordEnvelope {
  const assessmentId = validatedUuid(input.assessmentId, "assessmentId");
  const correlationId = validatedUuid(input.correlationId, "correlationId");
  const documentNumber = validatedDocumentNumber(input.documentNumber);
  const firstSurname = validatedFirstSurname(input.firstSurname);
  const providerPayload = validatedProviderPayload(input.providerPayload);
  const record: DataCreditoSecureRecord = {
    version: DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION,
    documentNumber,
    firstSurname,
    providerPayload,
  };

  let plaintext: Buffer | null = null;
  let config: EncryptionConfig | null = null;
  try {
    plaintext = Buffer.from(JSON.stringify(record), "utf8");
    assertPlaintextSize(plaintext.length);

    config = readEncryptionConfig(env);
    const key = config.keys.get(config.activeKeyId);
    if (!key) {
      configurationError("La clave activa de DataCredito no esta disponible.");
    }

    const nonce = randomBytes(DATA_CREDITO_SECURE_RECORD_NONCE_BYTES);
    const aad = buildAad({
      assessmentId,
      correlationId,
      keyId: config.activeKeyId,
      aadVersion: DATA_CREDITO_SECURE_RECORD_AAD_VERSION,
      plaintextVersion: DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION,
    });
    const cipher = createCipheriv(NODE_CIPHER, key, nonce, {
      authTagLength: DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    if (
      authTag.length !== DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES ||
      ciphertext.length !== plaintext.length
    ) {
      authTag.fill(0);
      ciphertext.fill(0);
      throw new DataCreditoSecureRecordValidationError(
        "No se pudo construir el expediente cifrado."
      );
    }

    return {
      algorithm: DATA_CREDITO_SECURE_RECORD_ALGORITHM,
      keyId: config.activeKeyId,
      aadVersion: DATA_CREDITO_SECURE_RECORD_AAD_VERSION,
      plaintextVersion: DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION,
      nonce,
      authTag,
      ciphertext,
      plaintextBytes: plaintext.length,
    };
  } finally {
    plaintext?.fill(0);
    disposeEncryptionConfig(config);
  }
}

function decryptedRecord(value: unknown): DataCreditoSecureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DataCreditoSecureRecordDecryptionError();
  }

  const record = value as Record<string, unknown>;
  if (record.version !== DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION) {
    throw new DataCreditoSecureRecordDecryptionError();
  }

  try {
    const documentNumber = validatedDocumentNumber(record.documentNumber);
    const firstSurname = validatedFirstSurname(record.firstSurname);
    const providerPayload = validatedProviderPayload(record.providerPayload);
    return {
      version: DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION,
      documentNumber,
      firstSurname,
      providerPayload,
    };
  } catch {
    throw new DataCreditoSecureRecordDecryptionError();
  }
}

export function decryptDataCreditoSecureRecord(
  input: DecryptDataCreditoSecureRecordInput,
  env: EnvironmentSource = process.env
): DataCreditoSecureRecord {
  let config: EncryptionConfig | null = null;
  let plaintext: Buffer | null = null;
  let nonce: Buffer | null = null;
  let authTag: Buffer | null = null;
  let ciphertext: Buffer | null = null;

  try {
    const assessmentId = validatedUuid(input.assessmentId, "assessmentId");
    const correlationId = validatedUuid(input.correlationId, "correlationId");
    if (
      input.algorithm !== DATA_CREDITO_SECURE_RECORD_ALGORITHM ||
      input.aadVersion !== DATA_CREDITO_SECURE_RECORD_AAD_VERSION ||
      input.plaintextVersion !== DATA_CREDITO_SECURE_RECORD_PLAINTEXT_VERSION ||
      !KEY_ID_PATTERN.test(String(input.keyId || ""))
    ) {
      throw new DataCreditoSecureRecordDecryptionError();
    }
    assertPlaintextSize(input.plaintextBytes);

    nonce = envelopeBuffer(
      input.nonce,
      DATA_CREDITO_SECURE_RECORD_NONCE_BYTES
    );
    authTag = envelopeBuffer(
      input.authTag,
      DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES
    );
    ciphertext = envelopeBuffer(input.ciphertext);
    if (
      ciphertext.length !== input.plaintextBytes ||
      ciphertext.length > DATA_CREDITO_SECURE_RECORD_MAX_PLAINTEXT_BYTES
    ) {
      throw new DataCreditoSecureRecordDecryptionError();
    }

    config = readEncryptionConfig(env);
    const key = config.keys.get(input.keyId);
    if (!key) {
      throw new DataCreditoSecureRecordDecryptionError();
    }

    const aad = buildAad({
      assessmentId,
      correlationId,
      keyId: input.keyId,
      aadVersion: input.aadVersion,
      plaintextVersion: input.plaintextVersion,
    });
    const decipher = createDecipheriv(NODE_CIPHER, key, nonce, {
      authTagLength: DATA_CREDITO_SECURE_RECORD_AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad, { plaintextLength: input.plaintextBytes });
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (plaintext.length !== input.plaintextBytes) {
      throw new DataCreditoSecureRecordDecryptionError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new DataCreditoSecureRecordDecryptionError();
    }
    return decryptedRecord(parsed);
  } catch (error) {
    if (error instanceof DataCreditoSecureRecordConfigurationError) {
      throw error;
    }
    if (error instanceof DataCreditoSecureRecordDecryptionError) {
      throw error;
    }
    throw new DataCreditoSecureRecordDecryptionError();
  } finally {
    plaintext?.fill(0);
    nonce?.fill(0);
    authTag?.fill(0);
    ciphertext?.fill(0);
    disposeEncryptionConfig(config);
  }
}
