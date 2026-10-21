import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { allySettlementDeliverySchemaStatements } from "../scripts/ally-settlement-delivery-schema.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createSettlementDeliveryStore, enqueueInitialSettlementDeliveries } = await jiti.import("../lib/ally-settlement-delivery-store.ts");
const { dispatchSettlementDeliveries } = await jiti.import("../lib/ally-settlement-delivery-dispatch.ts");
const { sendSettlementDelivery, SETTLEMENT_WHATSAPP_TEMPLATE_BODY } = await jiti.import("../lib/ally-settlement-delivery-provider.ts");
const { buildAllyPaymentSettlementPdf } = await jiti.import("../lib/ally-payment-settlement-pdf.ts");

function adapter(client) {
  return {
    $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).affectedRows || 0,
  };
}

test("flujo completo offline: commit, PDF real, Resend/Meta ficticios, aislamiento e idempotencia", async () => {
  const pg = new PGlite();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("La prueba prohíbe cualquier solicitud real de red"); };
  try {
    await pg.exec(`
      CREATE TABLE "Aliado" (id integer PRIMARY KEY, nombre text, email text, "telefonoWhatsapp" text);
      CREATE TABLE "LiquidacionAliado" (id integer PRIMARY KEY, "aliadoId" integer NOT NULL REFERENCES "Aliado"(id));
      INSERT INTO "Aliado" VALUES
        (1, 'COMERCIO SINTETICO UNO', 'uno@example.invalid', '573001000001'),
        (2, 'OTRO_ALIADO_NO_COMPARTIR', 'otro@example.invalid', '573001000002');
    `);
    for (const sql of allySettlementDeliverySchemaStatements) await pg.exec(sql);
    const db = { ...adapter(pg), $transaction: (fn) => pg.transaction((tx) => fn(adapter(tx))) };
    const store = createSettlementDeliveryStore(db);
    const snapshot = {
      id: 101, aliado: { id: 1, nombre: "COMERCIO SINTETICO UNO" },
      periodoInicio: "2026-10-01", periodoFin: "2026-10-15", saldoNeto: 720_000,
    };
    // Both records and their queues commit atomically. The dispatcher below is
    // deliberately restricted to one ally's settlement, leaving the other queued.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('INSERT INTO "LiquidacionAliado" VALUES (101,1),(202,2)');
      await enqueueInitialSettlementDeliveries(tx, snapshot, 99);
      await enqueueInitialSettlementDeliveries(tx, {
        ...snapshot, id: 202, aliado: { id: 2, nombre: "OTRO_ALIADO_NO_COMPARTIR" }, saldoNeto: 999_999,
      }, 99);
    });
    assert.equal((await db.$queryRawUnsafe('SELECT * FROM "AllySettlementDeliveryAttempt"')).length, 4);
    let pdfBuilds = 0;
    const document = (settlementId) => store.document(settlementId, async () => {
      assert.equal(settlementId, snapshot.id);
      pdfBuilds++;
      const line = {
        creditId: 701, creditDate: "2026-10-07", allyName: snapshot.aliado.nombre,
        siteName: "Sede de prueba uno", clientName: "CLIENTE FICTICIO UNO", clientDocument: "000000001",
        equipment: "EQUIPO SINTETICO ANDROID", imei: "000000000000001", platform: "ANDROID",
        saleValue: 1_000_000, initialPayment: 200_000, authorizedCredit: 800_000,
        intermediationPercentage: 10, intermediationValue: 80_000, payableValue: 720_000, status: "PAGADO",
      };
      return buildAllyPaymentSettlementPdf({
        settlementId, allyName: snapshot.aliado.nombre, periodStart: snapshot.periodoInicio, periodEnd: snapshot.periodoFin,
        bankApprovalNumber: "REFERENCIA-FICTICIA-101", status: "PAGADA", paidAt: new Date("2026-10-16T12:00:00Z"),
        registeredBy: "OPERADOR DE PRUEBA", creditCount: 1, totalSaleValue: line.saleValue,
        totalInitialPayment: line.initialPayment, totalAuthorizedCredit: line.authorizedCredit,
        totalIntermediation: line.intermediationValue, totalPayable: line.payableValue,
        totalAllyCollections: 0, totalAnnulmentAdjustments: 0, totalCentralCollectionAdjustments: 0,
        netBalance: snapshot.saldoNeto, balanceDirection: "PAGO_ALIADO",
        platformSummary: {
          ANDROID: { creditCount: 1, intermediationPercentage: 10, payableValue: line.payableValue },
          IPHONE: { creditCount: 0, intermediationPercentage: null, payableValue: 0 },
        },
        lines: [line], collections: [], annulmentAdjustments: [], centralCollectionAdjustments: [],
      });
    });
    const domainId = "11111111-1111-4111-8111-111111111111";
    const emailId = "22222222-2222-4222-8222-222222222222";
    const phoneId = "111111111111111";
    const wabaId = "222222222222222";
    const mediaId = "333333333333333";
    const graphBase = "https://graph.facebook.com/v25.0";
    const env = {
      ALLY_SETTLEMENT_DELIVERY_ENABLED: "true", RESEND_API_KEY: "TEST-KEY-NOT-A-CREDENTIAL", RESEND_SETTLEMENT_DOMAIN_ID: domainId,
      WHATSAPP_ACCESS_TOKEN: "TEST-TOKEN-NOT-A-CREDENTIAL", WHATSAPP_PHONE_NUMBER_ID: phoneId,
      WHATSAPP_BUSINESS_ACCOUNT_ID: wabaId, WHATSAPP_SETTLEMENT_TEMPLATE_NAME: "liquidacion_aliado_prueba",
      WHATSAPP_SETTLEMENT_TEMPLATE_LANGUAGE: "es_CO",
    };
    const requests = [];
    const outgoing = [];
    let emailPdf;
    let whatsappPdf;
    const fakeFetch = async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      const parsed = new URL(url);
      if (url === `https://api.resend.com/domains/${domainId}`) {
        assert.notEqual(options.method, "POST");
        return Response.json({ id: domainId, name: "finserpay.com", status: "verified", capabilities: { sending: "enabled" } });
      }
      if (url === "https://api.resend.com/emails") {
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.deepEqual(body.to, ["uno@example.invalid"]);
        assert.equal(body.from, "FINSER PAY <pagos@finserpay.com>");
        assert.equal(body.subject, "FINSER PAY | Liquidación del 01/10/2026 al 15/10/2026");
        assert.match(body.text, /COMERCIO SINTETICO UNO/);
        assert.match(body.text, /720\.000/);
        assert.match(body.text, /no confirma un desembolso/);
        assert.doesNotMatch(body.text, /OTRO_ALIADO|otro@example|999\.999/);
        assert.equal(body.attachments.length, 1);
        emailPdf = Buffer.from(body.attachments[0].content, "base64");
        outgoing.push({ channel: "EMAIL", body });
        return Response.json({ id: emailId });
      }
      assert.equal(parsed.origin, "https://graph.facebook.com", "No other provider host is allowed");
      if (url === `${graphBase}/${phoneId}?fields=id,display_phone_number`) {
        return Response.json({ id: phoneId, display_phone_number: "+57 312 4085562" });
      }
      if (parsed.pathname === `/v25.0/${wabaId}/phone_numbers`) {
        return Response.json({ data: [{ id: phoneId, display_phone_number: "+57 312 4085562" }] });
      }
      if (parsed.pathname === `/v25.0/${wabaId}/message_templates`) {
        assert.equal(parsed.searchParams.get("name"), env.WHATSAPP_SETTLEMENT_TEMPLATE_NAME);
        return Response.json({ data: [{
          name: env.WHATSAPP_SETTLEMENT_TEMPLATE_NAME, status: "APPROVED", language: "es_CO", parameter_format: "POSITIONAL",
          components: [{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: SETTLEMENT_WHATSAPP_TEMPLATE_BODY }],
        }] });
      }
      if (url === `${graphBase}/${phoneId}/media`) {
        assert.equal(options.method, "POST");
        const file = options.body.get("file");
        assert.equal(file.type, "application/pdf");
        whatsappPdf = Buffer.from(await file.arrayBuffer());
        return Response.json({ id: mediaId });
      }
      if (url === `${graphBase}/${phoneId}/messages`) {
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.equal(body.to, "573001000001");
        assert.equal(body.template.components[0].parameters[0].document.id, mediaId);
        const values = body.template.components[1].parameters.map((item) => item.text);
        assert.deepEqual(values.slice(0, 3), [snapshot.aliado.nombre, "01/10/2026", "15/10/2026"]);
        assert.match(values[3], /720\.000/);
        assert.doesNotMatch(JSON.stringify(body), /OTRO_ALIADO|573001000002|999\.999/);
        outgoing.push({ channel: "WHATSAPP", body });
        return Response.json({ messages: [{ id: "wamid.offline-fixture-101==" }] });
      }
      assert.fail(`Unexpected fake provider request: ${url}`);
    };
    const send = (input, options) => sendSettlementDelivery(input, { ...options, env, fetch: fakeFetch });
    const result = await dispatchSettlementDeliveries({ store, document, send, settlementId: 101, limit: 10 });
    assert.equal(result.processed, 2);
    assert.equal(outgoing.length, 2);
    assert.equal(pdfBuilds, 1);
    assert.deepEqual(outgoing.map((item) => item.channel).sort(), ["EMAIL", "WHATSAPP"]);
    assert.equal(emailPdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.deepEqual(emailPdf, whatsappPdf, "Both channels must carry byte-identical PDFs");
    const [savedDocument] = await db.$queryRawUnsafe('SELECT * FROM "AllySettlementDocument"');
    assert.equal(savedDocument.settlementId, 101);
    assert.deepEqual(Buffer.from(savedDocument.pdf), emailPdf);
    assert.equal(savedDocument.sha256, createHash("sha256").update(emailPdf).digest("hex"));
    const loading = getDocument({ data: new Uint8Array(emailPdf), useSystemFonts: true });
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1, "The real renderer must produce the complete single-credit document");
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map((item) => item.str).join(" ");
      assert.match(text, /COMERCIO SINTETICO UNO/);
      assert.match(text, /CLIENTE FICTICIO UNO/);
      assert.match(text, /Sede de prueba uno/);
      assert.match(text, /720\.000/);
      assert.doesNotMatch(text, /OTRO_ALIADO_NO_COMPARTIR|999\.999/);
    } finally { await loading.destroy(); }
    const listing = await store.list(101);
    assert.equal(listing.deliveries.length, 2);
    for (const delivery of listing.deliveries) {
      assert.equal(delivery.status, "SENT");
      assert.ok(delivery.attemptedAt);
      assert.ok(delivery.sentAt);
      assert.equal(delivery.error, null);
    }
    assert.equal((await store.list(202)).deliveries.every((item) => item.status === "PENDING"), true);
    const requestCount = requests.length;
    assert.equal((await dispatchSettlementDeliveries({ store, document, send, settlementId: 101 })).processed, 0);
    assert.equal(requests.length, requestCount, "Repeated worker runs cannot make another provider request");
    assert.equal(outgoing.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    await pg.close();
  }
});
