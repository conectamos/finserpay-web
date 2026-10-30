import { isMetaAutomationConfigured, type MetaAutomationTemplate } from "./whatsapp-automation-meta-config";
import type { sendWhatsAppAutomationTemplate } from "./whatsapp-automation-meta";

export type WhatsAppAutomationProvider = "dapta" | "meta";
export type MetaAutomationSender = typeof sendWhatsAppAutomationTemplate;

/** Unknown values disable dispatch; a typo must never select another transport. */
export function whatsAppAutomationProvider(env: NodeJS.ProcessEnv = process.env): WhatsAppAutomationProvider | null {
  const value = env.WHATSAPP_AUTOMATIONS_PROVIDER;
  return value === undefined || value === "" || value === "dapta" ? "dapta" : value === "meta" ? "meta" : null;
}

export { isMetaAutomationConfigured };
export type { MetaAutomationTemplate };

// The existing phone/policy helpers also run outside Next.js. Load the private
// database and provider transport only when an explicitly selected Meta send runs.
export const sendMetaAutomation: MetaAutomationSender = async (input, options) => {
  const { sendWhatsAppAutomationTemplate } = await import("./whatsapp-automation-meta");
  return sendWhatsAppAutomationTemplate(input, options);
};
