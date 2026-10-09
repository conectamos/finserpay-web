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

## Límite de verificación de la respuesta

No fue posible obtener un ejemplo autenticado de consulta en producción durante este cambio. El inspector acepta únicamente un firmante inequívoco con identidad coincidente, contacto completo y estado pendiente explícito. Las pruebas de respuesta usan datos sintéticos; no acreditan que el proveedor exponga esos campos en todos sus procesos.

Si la respuesta no contiene información suficiente, el sistema bloquea la operación con `FIRMASEGURO_RECIPIENT_UNVERIFIED` y pide revisar el mismo proceso en FirmaSeguro. Nunca selecciona un identificador anidado al azar, inventa un correo, crea otro proceso o sustituye el PDF. Para habilitar otro formato de respuesta se requiere un ejemplo verificado del proveedor y una prueba correspondiente.

Un reenvío cuya notificación quedó incierta no se repite automáticamente: requiere revisar su entrega en FirmaSeguro. El registro incierto se conserva en el historial. Si una corrección contractual autorizada sustituye ese proceso, la incertidumbre histórica no bloquea la gestión del proceso nuevo.
