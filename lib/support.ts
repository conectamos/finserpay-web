export const FINSER_PAY_SUPPORT_NUMBER = "573144201136";
export const FINSER_PAY_SUPPORT_DISPLAY = "314 420 1136";

export function buildFinserPaySupportHref(message: string) {
  return `https://wa.me/${FINSER_PAY_SUPPORT_NUMBER}?text=${encodeURIComponent(
    String(message || "").trim()
  )}`;
}

export const FINSER_PAY_SUPPORT = {
  ariaLabel: "Contactar soporte de FINSER PAY por WhatsApp",
  href: buildFinserPaySupportHref(
    "Hola, equipo de FINSER PAY 👋 Necesito ayuda con mi crédito. ¿Podrían orientarme, por favor?"
  ),
  rel: "noopener noreferrer",
  target: "_blank",
} as const;
