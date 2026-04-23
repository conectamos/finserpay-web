import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "scrypt";
const KEY_LENGTH = 64;

export function isPasswordHash(value: string) {
  return value.startsWith(`${HASH_PREFIX}$`);
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, KEY_LENGTH);

  return `${HASH_PREFIX}$${salt}$${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, storedValue: string) {
  if (!storedValue) {
    return false;
  }

  if (!isPasswordHash(storedValue)) {
    return storedValue === password;
  }

  const [, salt, expectedHash] = storedValue.split("$");

  if (!salt || !expectedHash) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHash, "hex");

  if (expectedBuffer.length === 0) {
    return false;
  }

  const candidateBuffer = scryptSync(password, salt, expectedBuffer.length);

  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}
