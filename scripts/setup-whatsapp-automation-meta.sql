BEGIN;
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS "WhatsAppAutomationMetaOutbox" (
  id uuid PRIMARY KEY, "operationKey" text NOT NULL UNIQUE, provider text NOT NULL CHECK(provider='meta'),
  fingerprint text NOT NULL, "templateName" text NOT NULL CHECK("templateName" IN ('bienvenida','1_dia_falta','hoyvence','data','2dias','cuotavencida','bloqueo')),
  language text NOT NULL, "phoneNumberId" text NOT NULL, "wabaId" text NOT NULL, "contactId" text NOT NULL,
  "bodyParameters" jsonb NOT NULL CHECK(jsonb_typeof("bodyParameters")='array'), "headerImageUrl" text,
  "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  "messageId" uuid NOT NULL REFERENCES "AttentionMessage"(id) ON DELETE RESTRICT,
  "renderedText" text NOT NULL DEFAULT '', "templateMetadata" jsonb, "uploadedMediaId" text, "mediaMimeType" text,
  status text NOT NULL CHECK(status IN ('queued','sending','accepted','sent','delivered','read','failed','uncertain')),
  wamid text, "leaseToken" uuid, "leaseUntil" timestamptz, "sendStartedAt" timestamptz,
  "acceptedAt" timestamptz, "deliveryAt" timestamptz, "errorCode" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("phoneNumberId",wamid)
);
CREATE INDEX IF NOT EXISTS "WhatsAppAutomationMetaOutbox_conversation" ON "WhatsAppAutomationMetaOutbox"("conversationId","createdAt");
COMMIT;
