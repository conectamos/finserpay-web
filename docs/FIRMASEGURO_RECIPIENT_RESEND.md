# Actualizar y reenviar el mismo firmante en FirmaSeguro

Fuente consultada el 9 de octubre de 2026: [API v2 oficial, Swagger JSON](https://demo.firmaseguro.co/api/swagger/v2/swagger.json), enlazada desde la [documentación oficial](https://firmaseguro.atlassian.net/wiki/spaces/FIRMASEGUR/pages/353468417/Consumo+API+PROCESS+Crear+procesos+de+Firma+V2). El ambiente de ese contrato es **Pre-Prod**. Swagger en producción devuelve 404; no se realizaron mutaciones al consultar el contrato.

| Operación | Método y ruta |
| --- | --- |
| Consultar firmantes del proceso | `GET /api/v2/Signature/get-signatures-status/{uuid}` |
| Editar el firmante existente | `PUT /api/v2/Signature/edit-signature` |
| Reenviar su notificación | `GET /api/v2/Signature/resend-signature/{id}` |

El PUT utiliza `SignatureEditAPI`: `uuid`, `signature_id` (int32), `authentication_method_id`, `contact_information`, `signatory_type` y `template_rol`. El contacto requiere `email`, `first_name`, `first_last_name` y `mobile_number`; admite nombres secundarios, identificación e indicativo. Deben conservarse los datos de identidad existentes.

Editar exige un firmante sin firma ni rechazo. Reenviar exige además un proceso activo. El contrato describe el reenvío como notificación por correo; no garantiza WhatsApp. Las respuestas de éxito no tienen esquema tipado: cualquier extracción del identificador debe fallar ante ambigüedad.

Ambas mutaciones usan la autorización existente, tienen límite de espera y no reintentan automáticamente. Aunque el reenvío use GET, debe tratarse como escritura. Un timeout requiere conciliación; nunca crear un proceso alternativo ni regenerar el PDF.

La [ayuda oficial](https://firmaseguro.co/soporte/) confirma el flujo del portal: editar destinatario en el mismo proceso y reenviar su aviso. No permite deducir contratos adicionales de API.

## Respuesta de producción y verificación del firmante

El 15 de octubre de 2026 se verificó la estructura de una respuesta real mediante una consulta de solo lectura que devolvió exclusivamente nombres de campos, tipos, cantidades y comprobaciones booleanas. No se extrajeron contactos, identidades, UUID ni documentos de producción. La respuesta contiene `uuid`, `status_process` y un arreglo `signatures` con un único objeto: `id` numérico, `email`, `status`, `date_signed`, `code_message` y `message`. No devuelve nombre, identificación ni teléfono.

Exigir esos campos ausentes bloqueaba la gestión antes del PUT. El inspector admite ahora ese formato concreto solo con UUID exacto del proceso vigente, un único identificador numérico válido, estados pendientes, ausencia de fechas de firma/rechazo y correo coincidente con el original congelado o una edición anterior confirmada del mismo firmante. La identidad y la autenticación se conservan desde el envío original; ningún dato contractual se obtiene del formulario de reenvío.

Se distingue el contacto completo leído del proveedor de los datos originales o de una edición confirmada que sirven para construir el PUT. El teléfono del original nunca cuenta como verificación del contacto actual: con la respuesta limitada siempre se ejecuta la edición antes del reenvío. Tras un PUT confirmado se releen el mismo UUID, identificador, estado y correo. El teléfono se respalda en el acuse HTTP exitoso del PUT, no en una lectura que no lo incluye.

Un PUT sin respuesta confirmada permanece incierto. La coincidencia del correo no acredita que el teléfono se haya actualizado y nunca autoriza repetir la edición o reenviar automáticamente. Las respuestas explícitas de error, incluso un `ResponseVM` con `status: Error` o `statusCode >= 400` dentro de HTTP 200, no se consideran confirmaciones.

Las pruebas reproducen esa estructura con valores ficticios y conservan los rechazos ante múltiples firmantes, UUID/identidad contradictorios o evidencias de firma. Los formatos desconocidos siguen produciendo `FIRMASEGURO_RECIPIENT_UNVERIFIED`; no se crean procesos alternativos ni se sustituye el PDF.

Un reenvío cuya notificación quedó incierta no se repite automáticamente: requiere revisar su entrega en FirmaSeguro. El registro incierto se conserva en el historial. Si una corrección contractual autorizada sustituye ese proceso, la incertidumbre histórica no bloquea la gestión del proceso nuevo.
