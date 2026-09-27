# Postulaciones públicas de comercios

La página `/` envía `POST /api/postulaciones`. El servidor valida los datos y la
autorización, guarda la solicitud en PostgreSQL y luego intenta enviar un correo
a **comercial@finserpay.com**. La confirmación al comercio certifica recepción
en la base de datos, no entrega del correo ni aprobación como aliado.

## Configuración externa necesaria

1. En [Resend Domains](https://resend.com/domains), agrega **finserpay.com** con
   capacidad de envío. En el proveedor DNS de finserpay.com copia exactamente los
   registros de verificación que Resend muestre para esa cuenta: DKIM y SPF/MX
   del subdominio de retorno que indique. Conserva los MX que reciben el correo
   actual del dominio; no sustituyas la configuración del buzón comercial.
   Ejecuta la verificación en Resend y espera estado **Verified** con envío activo.
   Los valores concretos de DNS los genera la cuenta Resend; no pueden deducirse
   desde este repositorio. Revisa también DMARC conforme a la configuración real.
2. Crea una API key para envío del dominio y guárdala en **Variables/Secrets del
   servicio web de Railway** como `RESEND_API_KEY`. Nunca uses `NEXT_PUBLIC_`,
   el frontend, un archivo versionado ni logs para esta clave. Para el script
   de comprobación de entrega la clave también necesita lectura de emails;
   una clave limitada solo a envío no permite esa consulta.
3. Configura `MERCHANT_APPLICATION_FROM` como
   `FINSER PAY <postulaciones@finserpay.com>`. Se admite otra dirección del dominio
   raíz `finserpay.com` verificado. La aplicación rechaza remitentes de prueba de
   Resend u otros dominios. El destinatario comercial es fijo en el servidor y
   el correo del postulante se usa únicamente como `reply_to`.
4. Mantén `DATABASE_URL` conectado al PostgreSQL del proyecto. El predeploy debe
   ejecutar `scripts/ensure-merchant-applications-schema.mjs`; crea las tablas
   nuevas de forma idempotente y no modifica tablas de portales o créditos.
5. El cron interno reintenta automáticamente cada cinco minutos y al arrancar,
   sin token HTTP. Está activo por defecto en producción; se controla con
   `FINSERPAY_INTERNAL_CRON` (`true` lo activa, `false` lo desactiva). Omite la cola
   sin consultas de BD cuando falta una clave o remitente válido. Procesa hasta
   diez pendientes por ejecución y respeta el backoff; los bloqueos de BD evitan
   duplicación si hay varias instancias. Requiere un proceso Node persistente,
   como el servicio Railway del proyecto, para mantener el temporizador activo.
6. Solo para reintentos manuales por endpoint o un cron externo configura un secreto aleatorio de al
   menos 32 caracteres como `MERCHANT_APPLICATION_RETRY_TOKEN` (o utiliza
   `CRON_SECRET` si ya existe con esa longitud). Para el script remoto configura
   también `FINSERPAY_BASE_URL=https://finserpay.com`.

No basta con poner una dirección en `MERCHANT_APPLICATION_FROM`: la verificación
del dominio debe completarse en Resend. Sin clave o remitente válido, la solicitud
queda `PENDING`, con código `MISSING_EMAIL_CONFIGURATION`, y se conserva completa.
El servidor no crea cuentas Resend ni modifica DNS automáticamente.

## Contrato del formulario

JSON: `requestId` UUID estable mientras se reintenta un mismo envío,
`nombreComercio`, `nombreContacto`, `telefono`, `email`, `ciudad`,
`presenciaDigital` (web, Instagram, Facebook o @usuario), `aceptaPrivacidad: true`.
Opcionales: `nit`, `direccion`, `mensaje`; `website` es un campo trampa vacío.
Se registra la versión de consentimiento del servidor.

Éxito: HTTP 201 nuevo / 200 existente con `{ ok, solicitudId, message }`.
Validación: 422 con `fields`; clave reutilizada para otros datos: 409; límite
diario de 5 solicitudes distintas por correo: 429. JSON máximo: 16 KiB.
Si la base de datos falla, devuelve 503 y no muestra una recepción ficticia.

Todos los campos del formulario, número de solicitud, fecha de recepción y
autorización aparecen en el correo. No se guardan errores libres del proveedor
ni se registran datos personales o claves en logs.

## Reintentos y ausencia de duplicados

La solicitud y la notificación pendiente están en una misma fila persistente
`MerchantApplication`. `MerchantApplicationRequest` conserva la asociación de
cada UUID de envío con esa fila. Los reintentos con el mismo UUID siempre devuelven
la misma solicitud; datos idénticos con un nuevo UUID se deduplican durante 24h.

El envío usa una reserva exclusiva de dos minutos y la clave Resend
`merchant-application/<solicitudId>`. El destinatario, remitente y contenido se
congelan en `mailPayload`, con serialización estable incluso al leer JSONB.
Si el correo fue aceptado pero se perdió la respuesta o la actualización de BD,
se recupera la reserva vencida y se usa la misma clave y exactamente el mismo
contenido. Los reintentos públicos respetan el intervalo progresivo; un reintento
autorizado de una solicitud concreta puede adelantarlo.

Resend conserva claves idempotentes **24 horas**. Un resultado incierto con más
de 23 horas pasa a `REVIEW` y no se reenvía a ciegas. Debe revisarse primero en el
panel del proveedor por el UUID del asunto. Si ya existe, concilia su ID y estado;
solo si se confirma que no existe puede un operador devolverlo a `PENDING`,
reiniciando `firstAttemptAt` y `ambiguousAttempt`. No cambies `mailPayload` ni el
ID de una solicitud cuyo envío pueda haber sido aceptado. Incluso ante rechazo
definitivo se conserva el remitente original: verifica ese remitente/dominio
antes de reintentar; cambiar la variable no reescribe correos ya preparados.

Estados: `PENDING` por configurar/fallido; `SENDING` con reserva; `ACCEPTED` cuando
Resend responde con ID; `DELIVERED` después de verificar evidencia de entrega;
`REVIEW` cuando hace falta conciliación. `ACCEPTED` **no significa** que llegó al
buzón. Las notificaciones aceptadas o entregadas nunca se vuelven a enviar.

Reintento manual desde un entorno servidor con los secretos disponibles:

```sh
node scripts/retry-merchant-applications.mjs <solicitudId>
```

Para procesar hasta 10 pendientes con backoff, omite el ID. También puede invocarse
`POST /api/postulaciones/reintentar`, `Authorization: Bearer <secreto>`, y JSON
`{"limit":10}` o `{"solicitudId":"UUID"}`. Devuelve solo contadores. Un cron externo
puede ejecutar el script cada cinco minutos si el cron interno no está activo.
No hace falta configurar un segundo cron ni un token para los reintentos internos.

## Verificación antes de publicar

1. Ejecuta `npm ci` y `npm run test:public-site`. Además de validación
   y HTTP, las pruebas con `@electric-sql/pglite` verifican persistencia SQL real
   aislada, duplicados, fallos del proveedor, caída posterior al envío, reservas,
   límite diario y protección al vencer la ventana de idempotencia. No envían
   correos ni se conectan a producción. PGlite y Jiti son dependencias de
   desarrollo versionadas: la integración es obligatoria en CI, no se omite
   silenciosamente si el motor no está disponible.
2. Con esquema y secretos configurados, abre `/`, `/aliados` y `/clientes` y
   verifica los accesos. Una página de login que carga no prueba la autenticación:
   se necesitan cuentas de prueba autorizadas para completar el ingreso de un
   aliado y de un cliente y comprobar sus sesiones y operaciones habituales.
   Sin esas credenciales, registra expresamente ese alcance sin afirmar una
   prueba E2E de los portales. Envía una postulación claramente identificada como
   prueba desde la página y anota `solicitudId`.
3. Comprueba el registro de BD y el estado en Resend. Para verificar entrega desde
   servidor: `node scripts/check-merchant-application-delivery.mjs <solicitudId>`.
   Este script consulta el email por ID, comprueba el destinatario y marca
   `DELIVERED` solo cuando el último evento es `delivered`, `opened` o `clicked`.
   `deliveredAt` registra cuándo se comprobó la entrega. Código de salida 2:
   entrega aún sin comprobar; 1: error; 0: entrega confirmada por el proveedor.
4. Revisa realmente el buzón **comercial@finserpay.com** (incluidos spam/reglas)
   y confirma que los datos llegaron completos. El evento del proveedor confirma
   aceptación por el servidor receptor; la revisión del buzón confirma dónde llegó.
   Sin acceso al buzón no se debe afirmar que esa inspección se realizó.
5. Repite el envío con el mismo ID: debe existir una solicitud y una notificación.
   Simula un fallo de correo en un entorno aislado: la recepción debe seguir
   confirmándose y el reintento posterior debe notificar sin duplicar.

Fuentes del proveedor: [dominios](https://resend.com/docs/dashboard/domains/introduction),
[idempotencia](https://resend.com/docs/dashboard/emails/idempotency-keys) y
[consulta de email](https://resend.com/docs/api-reference/emails/retrieve-email).
