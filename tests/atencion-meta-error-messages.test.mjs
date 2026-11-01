import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { attentionMetaFailureMessage } = await jiti.import("../lib/atencion-meta-error-messages.ts");
const { attentionMetaReplyMessage } = await jiti.import("../lib/atencion-meta-storage.ts");
const row = (patch = {}) => ({ id: "00000000-0000-4000-8000-000000000001", conversationId: "00000000-0000-4000-8000-000000000002",
  text: "Mensaje de prueba", authorName: "Analista", createdAt: "2026-11-01T16:30:00Z", acceptedAt: null,
  messageId: null, status: "failed", errorCode: "META_UNAVAILABLE", attachment: null, ...patch });

test("fallo confirmado de conexión explica que el mensaje no salió sin atribuirlo al archivo", () => {
  const failed = attentionMetaReplyMessage(row({ attachment: { kind: "document", mimeType: "application/pdf", fileName: "prueba.pdf", size: 3315 } }));
  assert.equal(failed.deliveryStatus, "failed");
  assert.equal(failed.deliveryError, "No se pudo conectar con Meta. El mensaje no se envió. Puedes preparar un nuevo intento.");
  assert.equal(failed.attachment.url, null);
  assert.doesNotMatch(failed.deliveryError, /vacío|tamaño|3315|prueba\.pdf/);
});

test("ventana, archivo y validación previa usan explicaciones fijas correspondientes a códigos existentes", () => {
  assert.match(attentionMetaFailureMessage("SERVICE_WINDOW_CLOSED"), /24 horas.*plantilla aprobada/);
  assert.match(attentionMetaFailureMessage("MEDIA_TOO_LARGE"), /vacío o supera/);
  assert.match(attentionMetaFailureMessage("INVALID_MEDIA_CONTENT"), /contenido.*formato/);
  assert.match(attentionMetaFailureMessage("SEND_PRECONDITION_FAILED"), /validación previa.*Actualiza el chat/);
  assert.equal(attentionMetaFailureMessage("USER_CANCELLED"), "Este intento fue cancelado.");
});

test("incertidumbre conserva la advertencia de no reenviar aunque el código sea de conexión", () => {
  for (const errorCode of ["META_UNAVAILABLE", "LEASE_EXPIRED_AFTER_SEND", "ACK_PENDING", "SECRET_TOKEN_IN_PROVIDER_ERROR"]) {
    const message = attentionMetaReplyMessage(row({ status: "uncertain", errorCode }));
    assert.equal(message.deliveryStatus, "uncertain");
    assert.equal(message.deliveryError, "El envío está pendiente de confirmación. No lo reenvíes.");
    assert.doesNotMatch(message.deliveryError, /nuevo intento|SECRET|ACK_PENDING|META_UNAVAILABLE/);
  }
});

test("estados confirmados no se convierten en fallos ni publican códigos obsoletos", () => {
  for (const status of ["queued", "sending", "accepted", "sent", "delivered", "read"]) {
    const message = attentionMetaReplyMessage(row({ status, errorCode: "META_UNAVAILABLE" }));
    assert.equal(message.deliveryStatus, status);
    assert.equal(message.deliveryError, null);
  }
});

test("códigos desconocidos o maliciosos conservan el mensaje genérico y no filtran el proveedor", () => {
  for (const code of [null, undefined, "131000", "SECRET_TOKEN_IN_PROVIDER_ERROR", "__proto__", "toString", "META_UNAVAILABLE\nSECRET", { code: "META_UNAVAILABLE" }]) {
    assert.equal(attentionMetaFailureMessage(code), "No se pudo enviar el mensaje.");
    assert.equal(attentionMetaReplyMessage(row({ errorCode: code })).deliveryError, "No se pudo enviar el mensaje.");
  }
});
