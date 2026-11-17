# Actualizar y reenviar el mismo firmante en FirmaSeguro

## Integración preparada: portal con correo y contraseña

La integración de **Gestionar firma** usa el portal `https://app.firmaseguro.co`
para las nuevas operaciones cuando su activación explícita está habilitada.
Está desactivada por defecto y exige validar el contenedor Linux y el acceso
antes de habilitarla. La prueba real de entrega requiere un caso pendiente
autorizado y puede realizarse después de la activación por decisión del administrador.
La API sigue consultando el proceso
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
ambigua detiene la operación. Antes de editar y antes de confirmar el reenvío
se exige que la sección **Notificaciones** confirme WhatsApp habilitado y correo
deshabilitado. La configuración se lee de sus indicadores explícitos, no del
método de autenticación **OTP Whatsapp**. Una configuración desconocida, mixta
o cambiada bloquea la operación; no se modifica para forzar el envío.

El historial guarda el contacto anterior leído del portal (`PORTAL_READBACK`),
el contacto solicitado, `afterContact.transport: "PORTAL"` y
`afterContact.configuredNotificationChannel: "WHATSAPP"`. Una edición sin
confirmación se concilia mediante lectura antes de continuar. Un reenvío iniciado
o incierto nunca se repite automáticamente. La confirmación **Solicitud reenviada**
acredita la aceptación del portal. La configuración WhatsApp queda separada de
la emisión efectiva, la entrega y la lectura, que permanecen sin confirmar.
El control del proveedor conserva el título **Reenviar correo**; no se interpreta
como prueba de envío por ese canal ni como recibo de WhatsApp.
Los reintentos de operaciones históricas sin marcador
de transporte conservan su flujo API original.

El contenedor incluye Chromium headless de Playwright, de la misma versión exacta
que la dependencia de producción, bajo `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`.
En desarrollo se instala con `npx playwright install --only-shell chromium`.
Cuando el contenedor web no permite el sandbox, el navegador se ejecuta en un
worker privado separado, manteniendo el sandbox y el mismo Playwright 1.65.0.
El código del portal y sus controles siguen en FINSERPAY; el worker solo aloja
el navegador y su gateway autenticado. No existe fallback automático entre
transportes tras un fallo.
El proceso se ejecuta sin root y exige el sandbox de Chromium, sin desactivarlo
como alternativa si el entorno no lo admite. El navegador recibe solo variables
del sistema necesarias para arrancar; no hereda los secretos de la aplicación.
Cada operación cierra su contexto; no guarda perfiles, capturas ni trazas de acceso.
Cada respuesta de red se consulta sin reintentos ni seguimiento automático de
redirecciones. Las redirecciones de navegación admitidas se convierten en un GET
nuevo sujeto a la misma validación; nunca se propaga el cuerpo de un POST a otro
salto. Se bloquean POST 307/308, redirecciones AJAX, destinos desconocidos y
cabeceras Refresh. Las pruebas sintéticas comprueban cookies y cadenas de
redirección sin usar cuentas ni notificaciones reales.
Las pruebas automatizadas usan un portal simulado. El 13 de noviembre de 2026 se
comprobó además el inicio de sesión real y el listado con Chromium headless en
Windows, usando las credenciales actuales de Railway sin mostrarlas. La consulta
utiliza `verifyFirmaSeguroPortalAccess()`, que comparte el acceso y las
restricciones de navegación con la gestión de destinatarios y cierra siempre su
sesión. La comprobación identificó la ruta canónica de contraseña
`/Identity/Account/SignInPassword`, ahora permitida de forma específica.

Esa consulta no editó contactos ni reenvió solicitudes. La comprobación del
contenedor Linux precede a la activación; la edición/reenvío real se valida
cuando exista un caso pendiente autorizado. La revisión de solo lectura del 17 de
noviembre confirmó la separación de los indicadores de notificación y OTP en
el portal. El caso disponible ya estaba firmado y no se editó ni reenvió.

### Activación y validación pendiente

- `FIRMASEGURO_PORTAL_RESEND_ENABLED` debe ser exactamente `true`. Ausente,
  `false` u otro valor bloquea nuevas operaciones y continuaciones del portal
  antes de autenticar o mutar. Las operaciones API históricas conservan su transporte.
- `FIRMASEGURO_PORTAL_RESEND_DRAFT_IDS` permite limitar el piloto a IDs internos
  de solicitudes separados por coma. Ausente permite todos al activar; vacío,
  inválido o ambiguo bloquea todos. No usar una solicitud ya firmada para el piloto.
- Verificar primero arranque Chromium con sandbox y acceso/listado en el mismo
  contenedor Linux, sin editar contactos ni reenviar. Un fallo de sandbox o de
  estructura se resuelve antes de habilitar el piloto.
- El arranque de Docker y `railway.toml` usan `scripts/start-finserpay.mjs`.
  Con `FIRMASEGURO_PORTAL_VERIFY_ACCESS_ON_START=true` se prueba acceso sin
  habilitar mutaciones. Con `FIRMASEGURO_PORTAL_RESEND_ENABLED=true` cada contenedor
  repite la misma comprobación antes de ofrecer esa función. El probe usa el
  driver compilado del mismo código, Linux, UID no root y Playwright 1.65.0.
  El proceso tiene un límite total de 120 segundos y solo registra un acuse
  técnico o un código estable. No filtra ni abre procesos de clientes.
- Si la comprobación falla, se cierra el gate del portal en ese proceso y
  FINSERPAY continúa disponible. Para el primer despliegue usar `RESEND_ENABLED=false`
  y `VERIFY_ACCESS_ON_START=true` con los prefijos completos anteriores; comprobar
  el evento `firmaseguro_portal_runtime_verified` antes de activar. Un despliegue
  saludable por sí solo no demuestra éxito del probe. Tras activar, exigir el
  mismo evento con `resendEnabled:true`; `firmaseguro_portal_runtime_failed` indica
  que las mutaciones quedaron deshabilitadas, aunque la aplicación siga funcionando.
- Con un caso pendiente autorizado: confirmar proceso, firmante, folio y destino;
  realizar una única operación; verificar contacto por lectura del portal y
  correlacionar el mensaje con enlace de firma al destinatario y hora. Un OTP
  o el acuse genérico no sustituye esa comprobación. Si el resultado es incierto,
  no repetir el reenvío para probar de nuevo.
- Registrar por separado el resultado de la prueba real. Conservar credenciales,
  PDF, UUID, identidad, autenticación y configuración de notificaciones existentes.

Prueba de navegador opcional, exclusivamente con dos servidores loopback y
credenciales ficticias: ejecutar `tests/firmaseguro-portal.test.mjs` con
`FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_TEST=1`; se puede seleccionar el canal de
Chrome instalado con `FIRMASEGURO_PORTAL_SYNTHETIC_BROWSER_CHANNEL=chrome`.
Esta prueba no sustituye la comprobación del contenedor Linux ni la recepción
del enlace de firma de un caso autorizado.

## Navegador privado de FirmaSeguro

`Dockerfile.firmaseguro-browser` crea una imagen independiente con Node,
Playwright y `scripts/firmaseguro-browser-worker.mjs`. No copia la aplicación,
Prisma, documentos, archivos `.env` ni volúmenes. No se configuran credenciales
de base de datos ni de FirmaSeguro en ese servicio. Usuario y contraseña de
FirmaSeguro sí atraviesan transitoriamente el RPC y el navegador durante el
inicio de sesión; no se registran frames, headers, trazas ni capturas.

El worker exige Linux y UID no root, inicia Chromium con sandbox y entorno
mínimo y verifica un renderer sin red antes de estar listo. El servidor original
de Playwright solo escucha en loopback con su ruta aleatoria; el gateway
escucha por la red privada en el puerto 3010. `/connect` exige un único Bearer
con comparación de tiempo constante, Host y ruta exactos, y rechaza Origin,
cookies, query strings y redirecciones. Solo reenvía los headers del handshake
WebSocket a un destino loopback fijado por el propio proceso. Limita a tres
conexiones simultáneas y limpia cada conexión sin cerrar las de otros clientes.

La red privada de Railway se cifra mediante WireGuard; no se debe generar un
dominio público ni proxy TCP para el worker. El token permite control amplio de
Playwright en ese contenedor y debe mantenerse exclusivamente en variables del
servidor. No se entrega a clientes ni a Chromium. La imagen mínima limita el
alcance de ese control; no añadirle secretos, archivos o acceso a la base de datos.

Configuración del servicio `firma-portal-browser`:

- `RAILWAY_DOCKERFILE_PATH=Dockerfile.firmaseguro-browser`, puerto 3010 y arranque
  `node scripts/firmaseguro-browser-worker.mjs`, sin comandos predeploy de la app.
- `FIRMASEGURO_BROWSER_TOKEN`: secreto aleatorio base64url de al menos 32 caracteres.
- Comprobar su acuse de renderer, versión, UID y sandbox antes de conectar la app.

Configuración de FINSERPAY:

- `FIRMASEGURO_BROWSER_ENDPOINT=ws://firma-portal-browser.railway.internal:3010/connect`.
- `FIRMASEGURO_BROWSER_TOKEN` referencia el secreto del worker.
- Ambos valores son obligatorios para el transporte privado. Un endpoint distinto,
  par incompleto o error de conexión detiene el acceso sin iniciar un navegador local.
- La sonda Node recibe estas dos variables; el entorno del proceso Chromium no.

El acuse de FINSERPAY distingue `browserTransport: PRIVATE` de `LOCAL`. Su UID
corresponde a la sonda de la app; el sandbox y UID del navegador remoto se
verifican en el acuse propio del worker. Un login aceptado confirma acceso y
listado, no entrega de una solicitud de firma.

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
