export type MetaAutomationEnv = Record<string, string | undefined>;
export const META_AUTOMATION_TEMPLATES = Object.freeze({
  bienvenida: { language: "es", parameters: 1, imageEnv: null },
  "1_dia_falta": { language: "es", parameters: 2, imageEnv: null },
  hoyvence: { language: "es", parameters: 2, imageEnv: null },
  data: { language: "es", parameters: 1, imageEnv: null },
  "2dias": { language: "es", parameters: 1, imageEnv: "WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL" },
  cuotavencida: { language: "es_AR", parameters: 1, imageEnv: "WHATSAPP_AUTOMATIONS_CUOTAVENCIDA_HEADER_IMAGE_URL" },
  bloqueo: { language: "es", parameters: 0, imageEnv: "WHATSAPP_AUTOMATIONS_BLOQUEO_HEADER_IMAGE_URL" },
} as const);
export type MetaAutomationTemplate = keyof typeof META_AUTOMATION_TEMPLATES;
export const META_AUTOMATION_SCOPE = Object.freeze({ phoneNumberId: "1162059967000416", wabaId: "2148284059050848" });
export function metaAutomationHeaderUrl(value: string, template: MetaAutomationTemplate): string | null {
  if (!META_AUTOMATION_TEMPLATES[template]?.imageEnv) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://finserpay.com" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/whatsapp/templates/${template}.png` ? url.href : null;
  } catch { return null; }
}

export function isMetaAutomationConfigured(env: MetaAutomationEnv = process.env, template?: MetaAutomationTemplate): boolean {
  if (env.WHATSAPP_AUTOMATIONS_PROVIDER !== "meta" || env.WHATSAPP_ATTENTION_SEND_ENABLED !== "true"
    || env.WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED !== "true" || env.WHATSAPP_GRAPH_API_VERSION !== "v25.0"
    || env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID !== META_AUTOMATION_SCOPE.phoneNumberId
    || env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID !== META_AUTOMATION_SCOPE.wabaId
    || !env.WHATSAPP_ATTENTION_ACCESS_TOKEN?.trim()) return false;
  const imageEnv = template && META_AUTOMATION_TEMPLATES[template]?.imageEnv;
  return !imageEnv || Boolean(template && metaAutomationHeaderUrl(env[imageEnv] || "",template));
}
export const isWhatsAppAutomationMetaConfigured = isMetaAutomationConfigured;
