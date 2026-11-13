# Actualizar y reenviar el mismo firmante en FirmaSeguro

## Flujo vigente: portal con correo y contraseña

Desde el 13 de noviembre de 2026, las nuevas operaciones de **Gestionar firma**
utilizan el portal `https://app.firmaseguro.co`. La API sigue consultando el proceso
y vinculando su identificador de firmante; la edición del contacto y el reenvío
se realizan mediante los controles del portal. No existe retorno automático a las
mutaciones API cuando falla el portal.

El servidor inicia una sesión temporal con `FIRMASEGURO_PORTAL_EMAIL` y
`FIRMASEGURO_PORTAL_PASSWORD`. Si ninguna de las dos está definida, usa el par
existente `FIRMASEGURO_EMAIL` / `FIRMASEGURO_PASSWORD`. Un par específico incompleto
produce un error de configuración. Las credenciales permanecen en variables del
servidor; no se solicitan al analista ni se incluyen en el historial.

El navegador busca por cédula y folio, exige un único proceso y comprueba el
documento, el identificador del firmante, su identidad y que la firma continúe
pendiente. Solo cambia celular y correo, conserva los demás campos y verifica
el contacto guardado mediante una nueva lectura antes de reenviar. No crea otro
proceso ni sustituye el PDF. Un CAPTCHA, cambio de estructura o coincidencia
ambigua detiene la operación.

El historial guarda el contacto anterior leído del portal (`PORTAL_READBACK`),
el contacto solicitado y `afterContact.transport: "PORTAL"`. Una edición sin
confirmación se concilia mediante lectura antes de continuar. Un reenvío iniciado
o incierto nunca se repite automáticamente. La confirmación **Solicitud reenviada**
acredita la aceptación del portal; el canal, la entrega y la lectura del cliente
permanecen sin confirmar. Los reintentos de operaciones históricas sin marcador
de transporte conservan su flujo API original.

El contenedor incluye Chromium headless de Playwright, de la misma versión exacta
que la dependencia de producción, bajo `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`.
En desarrollo se instala con `npx playwright install --only-shell chromium`.
Cada operación cierra su contexto; no guarda perfiles, capturas ni trazas de acceso.
Las pruebas usan un portal simulado: antes de habilitarlo se debe comprobar el
inicio de sesión real con la cuenta autorizada y un caso de prueba pendiente.

## Referencia histórica: contrato API

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

## Disponibilidad en solicitudes

Los analistas y administradores centrales pueden gestionar el destinatario del
mismo documento pendiente tanto en iPhone como en Android. Se exige una solicitud
abierta en los pasos 3 o 4, un único proceso vigente y un firmante verificable sin
firma ni rechazo. El cambio conserva el documento, las condiciones, la identidad
y el método de autenticación del envío original. Este permiso no habilita cambios
de IMEI ni generación de otra versión del contrato para Android.

## Respuesta de producción y verificación del firmante

El 15 de octubre de 2026 se verificó la estructura de una respuesta real mediante una consulta de solo lectura que devolvió exclusivamente nombres de campos, tipos, cantidades y comprobaciones booleanas. No se extrajeron contactos, identidades, UUID ni documentos de producción. La respuesta contiene `uuid`, `status_process` y un arreglo `signatures` con un único objeto: `id` numérico, `email`, `status`, `date_signed`, `code_message` y `message`. No devuelve nombre, identificación ni teléfono.

Exigir esos campos ausentes bloqueaba la gestión antes del PUT. El inspector admite ahora ese formato concreto solo con UUID exacto del proceso vigente, un único identificador numérico válido, estados pendientes, ausencia de fechas de firma/rechazo y correo coincidente con el original congelado o una edición anterior confirmada del mismo firmante. La identidad y la autenticación se conservan desde el envío original; ningún dato contractual se obtiene del formulario de reenvío.

Se distingue el contacto completo leído del proveedor de los datos originales o de una edición confirmada que sirven para construir el PUT. El teléfono del original nunca cuenta como verificación del contacto actual: con la respuesta limitada siempre se ejecuta la edición antes del reenvío. Tras un PUT confirmado se releen el mismo UUID, identificador, estado y correo. El teléfono se respalda en el acuse HTTP exitoso del PUT, no en una lectura que no lo incluye.

Un PUT sin respuesta confirmada permanece incierto. La coincidencia del correo no acredita que el teléfono se haya actualizado y nunca autoriza repetir la edición o reenviar automáticamente. Las respuestas explícitas de error, incluso un `ResponseVM` con `status: Error` o `statusCode >= 400` dentro de HTTP 200, no se consideran confirmaciones.

Las pruebas reproducen esa estructura con valores ficticios y conservan los rechazos ante múltiples firmantes, UUID/identidad contradictorios o evidencias de firma. Los formatos desconocidos siguen produciendo `FIRMASEGURO_RECIPIENT_UNVERIFIED`; no se crean procesos alternativos ni se sustituye el PDF.

Un reenvío cuya notificación quedó incierta no se repite automáticamente: requiere revisar su entrega en FirmaSeguro. El registro incierto se conserva en el historial. Si una corrección contractual autorizada sustituye ese proceso, la incertidumbre histórica no bloquea la gestión del proceso nuevo.

## Acuse de reenvío y canal

El estado interno `RESENT` conserva el acuse de una solicitud de reenvío; no es un recibo de entrega ni de lectura. La pantalla identifica el reenvío por correo documentado por la API y mantiene explícitamente sin confirmar la entrega y la notificación por WhatsApp. El contacto y la fecha del último acuse se leen de la misma operación; una edición posterior no cambia el destinatario al que corresponde un acuse anterior.

La solicitud inicial puede tener `isSendByWhatsApp: true` y autenticación OTP 4 sin que eso demuestre un nuevo WhatsApp del enlace de firma. La documentación oficial distingue la notificación inicial del OTP. No se deduce una URL de firma a partir del `hash`, ni se llama a una ruta de WhatsApp sin un contrato verificable del proveedor.

Verificación del 17 de octubre de 2026: el [manual oficial para modificar y
reenviar un proceso](https://firmaseguro.atlassian.net/wiki/spaces/FIRMASEGUR/pages/2785349),
actualizado el 30 de diciembre de 2025, identifica la acción **Reenviar correo**.
La habilitación de Android conserva esta distinción: editar el celular del
firmante no acredita una nueva notificación del enlace por WhatsApp.

Las respuestas de edición y reenvío deben contener un acuse positivo explícito. HTTP 200 con cuerpo vacío, estructura desconocida, error explícito o un código `code_message` sin semántica documentada queda incierto; no autoriza registrar un reenvío aceptado ni repetir la notificación automáticamente.
