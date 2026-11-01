/** Public, fixed explanations for persisted failures. Never expose provider payloads. */
const failureMessages: Readonly<Record<string, string>> = {
  META_UNAVAILABLE: "No se pudo conectar con Meta. El mensaje no se envió. Puedes preparar un nuevo intento.",
  META_HTTP_ERROR: "Meta no pudo completar la solicitud. Revisa el estado del canal antes de preparar otro intento.",
  META_NOT_CONFIGURED: "La conexión de Atención con Meta requiere configuración. Comunícalo a administración.",
  META_SCOPE_CONFIG: "La configuración de la línea de Atención cambió. Comunícalo a administración antes de volver a enviar.",
  META_SCOPE_MISMATCH: "No se pudo verificar la línea autorizada de Atención en Meta. Comunícalo a administración.",
  META_SEND_DISABLED: "El envío desde Atención está deshabilitado. Comunícalo a administración.",
  META_CUTOVER_REQUIRED: "Falta confirmar la coordinación de la atención humana y la IA. Comunícalo a administración.",
  SERVICE_WINDOW_CLOSED: "La ventana de respuesta de 24 horas está cerrada. Utiliza una plantilla aprobada.",
  INVALID_RECIPIENT: "El destinatario de WhatsApp no es válido. Revisa el teléfono del contacto.",
  INVALID_TEXT: "El texto del mensaje no es válido. Revísalo antes de preparar otro intento.",
  INVALID_CAPTION: "El texto del adjunto no es válido. Revisa su longitud y el tipo de archivo.",
  MEDIA_TOO_LARGE: "El archivo está vacío o supera el límite permitido. Selecciona otro archivo.",
  UNSUPPORTED_MEDIA: "El formato o tamaño del archivo no está habilitado. Selecciona un archivo compatible.",
  INVALID_MEDIA_NAME: "El nombre o la extensión del archivo no corresponden a su formato. Revisa el adjunto.",
  INVALID_MEDIA_CONTENT: "El contenido del archivo no coincide con su formato. Selecciona nuevamente el adjunto.",
  INVALID_STICKER_DIMENSIONS: "El sticker debe medir 512 × 512 píxeles. Selecciona otro sticker.",
  INVALID_MEDIA_RECEIPT: "Meta no confirmó la carga del archivo. El mensaje no se envió. Prepara un nuevo intento.",
  INVALID_MEDIA_ID: "No se pudo identificar el archivo de este intento. Selecciona nuevamente el adjunto.",
  INVALID_MEDIA_URL: "No se pudo validar el archivo de Meta. El mensaje no se envió. Prepara un nuevo intento.",
  SEND_PRECONDITION_FAILED: "No se completó la validación previa al envío. Actualiza el chat y revisa sus permisos antes de preparar otro intento.",
  LEASE_EXPIRED_BEFORE_SEND: "El intento venció antes de iniciar el envío. Puedes preparar un nuevo intento.",
  USER_CANCELLED: "Este intento fue cancelado.",
};

/** Call only for a confirmed failed state; uncertainty must retain its no-resend warning. */
export function attentionMetaFailureMessage(errorCode: unknown): string {
  return typeof errorCode === "string" && Object.hasOwn(failureMessages, errorCode)
    ? failureMessages[errorCode]
    : "No se pudo enviar el mensaje.";
}
