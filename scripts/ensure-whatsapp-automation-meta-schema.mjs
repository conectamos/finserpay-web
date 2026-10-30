import pg from "pg";
import { installWhatsAppAutomationMetaSchema } from "./whatsapp-automation-meta-schema.mjs";
const connectionString=String(process.env.DATABASE_URL||"").trim();
if(!connectionString)throw new Error("DATABASE_URL no está configurada para automatizaciones WhatsApp.");
const client=new pg.Client({connectionString,connectionTimeoutMillis:10000,application_name:"finserpay-whatsapp-automation-meta-schema"});
try {
  await client.connect();await installWhatsAppAutomationMetaSchema(client);
  console.log("Cola de automatizaciones WhatsApp verificada: persistencia, idempotencia y relación con CRM preparadas. No se enviaron mensajes.");
} catch(error) {
  const code=String(error?.code||"").replace(/[^A-Z0-9_]/gi,"").slice(0,24);
  throw new Error(`No se pudo preparar la cola de automatizaciones WhatsApp${code?` (${code})`:""}.`);
} finally {await client.end().catch(()=>undefined);}
