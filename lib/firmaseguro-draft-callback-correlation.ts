import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const DISPATCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// FirmaSeguro returns GUIDs both with and without separators.
const PROCESS_UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PURPOSE = "finserpay:firmaseguro:draft-callback:v1:";

export function readDraftCallbackDispatchId(value: unknown) {
  return typeof value === "string" && DISPATCH_UUID.test(value) ? value.toLowerCase() : null;
}

export function readFirmaSeguroCallbackProcessUuid(value: unknown) {
  return typeof value === "string" && PROCESS_UUID.test(value) ? value : null;
}

function equalSecret(received: string | null, expected: string) {
  if (!received || received.length > 4096 || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(received).digest(),
    createHash("sha256").update(expected).digest());
}

function signature(dispatchId: string, secret: string) {
  return createHmac("sha256", secret).update(PURPOSE + dispatchId).digest("hex");
}

/** This proof correlates one dispatch; it never proves provider acceptance or a signed document. */
export function buildDraftSignatureCallbackUrl(callbackUrl: string, dispatchId: string, secret: string | null) {
  const id = readDraftCallbackDispatchId(dispatchId);
  if (!id) throw new Error("INVALID_DRAFT_CALLBACK_DISPATCH");
  if (!secret) return callbackUrl;
  const url = new URL(callbackUrl);
  // New callbacks receive only their own scope, never the reusable global secret.
  url.searchParams.delete("token");
  url.searchParams.set("dispatchId", id);
  url.searchParams.set("dispatchToken", signature(id, secret));
  return url.toString();
}

export function authorizeFirmaSeguroCallback(url: URL, headers: Headers, secret: string | null) {
  if (!secret) return { authenticated: false, dispatchId: null };
  const ids = url.searchParams.getAll("dispatchId");
  const proofs = url.searchParams.getAll("dispatchToken");
  if (ids.length || proofs.length) {
    const id = ids.length === 1 ? readDraftCallbackDispatchId(ids[0]) : null;
    const proof = proofs.length === 1 ? proofs[0] : null;
    const authenticated = Boolean(id && proof && /^[0-9a-f]{64}$/i.test(proof) &&
      equalSecret(proof.toLowerCase(), signature(id, secret)));
    return { authenticated, dispatchId: authenticated ? id : null };
  }
  const queryTokens = url.searchParams.getAll("token");
  const authenticated = (queryTokens.length === 1 && equalSecret(queryTokens[0], secret)) ||
    ["x-firmaseguro-token", "x-webhook-token", "x-callback-token"]
      .some(name => equalSecret(headers.get(name), secret));
  return { authenticated, dispatchId: null };
}
