# Envío de liquidaciones a aliados

El correo utiliza Resend y WhatsApp puede utilizar Dapta o Meta directamente. Los ensayos usan contactos ficticios,
PGlite y proveedores inyectados; no envían mensajes ni consultan bases productivas.

## Funcionamiento

Al crear una liquidación se guardan dos intentos, EMAIL y WHATSAPP, dentro de la misma
transacción. Solo después del commit se procesa la cola. La respuesta de creación no
depende del proveedor. El worker del servidor recupera trabajos pendientes cada 30 segundos
cuando está habilitado; varios procesos comparten reservas PostgreSQL con token por reserva.
Consultar el histórico, abrir el panel o descargar el PDF no procesa envíos.

Cada intento conserva destinatario, contenido, usuario, fechas, estado, error e ID del
proveedor. El destinatario se obtiene del aliado de esa liquidación; la API no acepta
destinatarios arbitrarios. Los reintentos explícitos toman los contactos actualizados.
Los intentos anteriores permanecen en la auditoría y en el campo history del endpoint.
El panel muestra fechas en America/Bogota. SENT significa aceptado por el proveedor;
no acredita lectura, llegada a bandeja principal ni desembolso. Meta directo recibe
eventos posteriores mediante su webhook firmado. Dapta concilia la aceptación del
envío mediante el recibo autenticado del flujo; no reporta entrega ni lectura posterior.

El PDF usa el generador existente, sin cambiar diseño ni cálculos. El mapeo del snapshot
se comparte entre descarga y envío; el primer PDF enviado queda almacenado con SHA-256
y se reutiliza idéntico para ambos canales y reenvíos. Meta directo utiliza carga autenticada.
Dapta recibe una URL firmada de 30 minutos, limitada al intento y al PDF ya guardado.
La URL no permite consultar otra liquidación ni generar documentos, tiene caché desactivada
y deja de servir cuando los envíos están deshabilitados. No existe un enlace público permanente.

El asunto es FINSER PAY | Liquidación del DD/MM/AAAA al DD/MM/AAAA. El texto incluye
aliado, período y neto con signo, y aclara que la liquidación no confirma un desembolso.

## Datos y migraciones

Aliado.email y Aliado.telefonoWhatsapp son opcionales y editables. Los valores
presentes se validan en cliente y servidor. La ausencia o invalidez bloquea únicamente
su canal. El código previo no tenía un teléfono WhatsApp propio en Aliado; no se copian
teléfonos de clientes, vendedores o usuarios. Completar estos datos desde Aliados.

railway-predeploy.mjs ejecuta ensure-ally-contact-schema.mjs y
ensure-ally-settlement-delivery-schema.mjs después del esquema de liquidaciones.
Docker incluye ambos instaladores y sus dependencias. Son migraciones aditivas;
no encolan liquidaciones históricas. No ejecutar prisma db push para sustituir estos
instaladores: la cola sigue el patrón SQL del proyecto.

## Configuración exacta

| Variable | Valor o acceso requerido |
| --- | --- |
| ALLY_SETTLEMENT_DELIVERY_ENABLED | true solo al activar envíos reales. Ausente/otro valor impide mensajes y registra error de configuración. |
| RESEND_API_KEY | Reutiliza la clave existente; necesita enviar y consultar el dominio mediante GET /domains/:id. |
| RESEND_SETTLEMENT_DOMAIN_ID | UUID del dominio raíz finserpay.com en la misma cuenta Resend. |
| WHATSAPP_SETTLEMENT_PROVIDER | `dapta` para reutilizar el canal oficial existente; `meta` (predeterminado) para acceso directo. |
| DAPTA_SETTLEMENT_WEBHOOK_URL | Ruta HTTPS autenticada del flujo exclusivo de liquidaciones en api.dapta.ai. Solo para el adaptador Dapta. |
| ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET | Secreto aleatorio de al menos 32 bytes, solo servidor. Firma autorizaciones por intento de 30 minutos; el secreto nunca se entrega a Dapta. |
| ALLY_SETTLEMENT_MEDIA_SECRET | Secreto aleatorio independiente de al menos 32 bytes para URLs temporales del PDF. |
| WHATSAPP_SETTLEMENT_ACCESS_TOKEN | Token exclusivo de liquidaciones con permisos whatsapp_business_messaging y whatsapp_business_management sobre el número y WABA oficiales. Si no está definido, usa WHATSAPP_ACCESS_TOKEN sin modificarlo. |
| WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID | 1162059967000416, confirmado para +57 3124085562; se verifica display_phone_number antes de cada envío. Si no está definido, usa WHATSAPP_PHONE_NUMBER_ID. |
| WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID | 2148284059050848, WABA del número oficial y de la plantilla aprobada. Si no está definido, usa WHATSAPP_BUSINESS_ACCOUNT_ID. Se verifica que la cuenta contiene el número. |
| WHATSAPP_GRAPH_API_VERSION | Reutiliza la versión existente; v25.0 por defecto. |
| WHATSAPP_SETTLEMENT_TEMPLATE_NAME | liquidacion_aliado; debe existir y estar aprobada con encabezado DOCUMENT. |
| WHATSAPP_SETTLEMENT_TEMPLATE_LANGUAGE | es_CO; debe coincidir con el idioma aprobado, no se toma el de otras campañas. |
| WHATSAPP_SETTLEMENT_APP_SECRET | Secreto de la app Meta dedicada al número oficial para verificar firmas del webhook. Si no está definido, usa WHATSAPP_APP_SECRET. |
| WHATSAPP_SETTLEMENT_VERIFY_TOKEN | Secreto aleatorio de al menos 32 caracteres para verificar la suscripción del webhook. |

Todas las credenciales deben almacenarse en variables servidor, nunca NEXT_PUBLIC.
Los tokens/secreto de app de Meta y su suscripción propia solo son necesarios para
el adaptador `meta`. Dapta utiliza la conexión de WhatsApp ya autorizada en su plataforma.
Las variables WHATSAPP_SETTLEMENT_* tienen prioridad únicamente para liquidaciones;
no se escriben ni cambian las variables compartidas ni las integraciones existentes.
Una variable dedicada definida pero vacía o inválida bloquea su operación: no se
reemplaza silenciosamente por el valor compartido. El adaptador Meta directo sigue
obligado a demostrar el número oficial, su pertenencia al WABA y la plantilla aprobada.
Su webhook usa el mismo PHONE_NUMBER_ID efectivo que el envío y rechaza firmas del
secreto compartido cuando existe WHATSAPP_SETTLEMENT_APP_SECRET.
El remitente de correo está fijado en FINSER PAY <pagos@finserpay.com>.
El adaptador verifica que Resend tenga finserpay.com verificado y envío habilitado;
no sustituye el remitente por otro dominio. La presencia de una clave no se considera
prueba de autorización.

La conexión oficial de Dapta corresponde a +57 3124085562, PHONE_NUMBER_ID
1162059967000416, WABA 2148284059050848 y canal Dapta
6933b28b-b0a1-400c-aa1e-54f75bfbbd91. Las conexiones de Diana y cobranza permanecen sin cambios.
La integración Meta compartida usa otro número; no se reutiliza su token para liquidaciones.
Resend se verificó mediante la clave existente: dominio finserpay.com, estado verified,
capabilities.sending=enabled e ID 1b0966af-1f99-48ca-8f92-870f3c92d47a, guardado en
RESEND_SETTLEMENT_DOMAIN_ID. No se envió correo para comprobarlo.

## Flujo Dapta y autorización de uso único

Flujo `BfHAJ`, **Liquidaciones aliados — PDF WhatsApp**, en el workspace FINSERPAY.
Su definición sin credenciales está en
`docs/integrations/ally-settlement-dapta/flow.json`; las pruebas ejecutan sus nodos de
código y verifican las conexiones sin invocar servicios externos. La URL autenticada
se guarda únicamente en `DAPTA_SETTLEMENT_WEBHOOK_URL` de Railway.

El adaptador envía solamente `event_id`, `recipient` y `callback_token`. Este último
es una autorización HMAC efímera vinculada al intento y al destinatario; no es una
credencial global. El flujo la utiliza como Bearer contra
`POST /api/integraciones/liquidaciones/dapta`:

1. `action: claim` comprueba la firma, el interruptor general, la reserva vigente,
   el canal y el destinatario. Una reserva única en PostgreSQL autoriza una sola ejecución.
2. La respuesta autorizada entrega nombre, período, neto, destinatario y URL del PDF
   obtenidos de los datos guardados. El flujo no acepta sustituciones desde su entrada.
3. El nodo nativo de Dapta usa canal y plantilla fijos, parámetros `var_1` a `var_4`
   y `header_media_url`. Solo un recibo real `wamid.*` prueba aceptación.
4. `action: receipt` concilia el mismo intento, destinatario, remitente e ID del
   proveedor. Una respuesta HTTP satisfactoria sin recibo no se registra como enviada.

La plantilla importada en Dapta tiene ID `71f2b7b4-64de-494b-91d8-6db523276c32`:
`liquidacion_aliado`, idioma `es_CO`, categoría UTILITY y encabezado DOCUMENT.
Fue aprobada en Meta e importada en Dapta el 23/10/2026. El PDF de muestra tiene datos ficticios.
La URL dinámica debe ser aceptada por la configuración del encabezado de Dapta;
no reemplazarla por el PDF de muestra en los envíos reales.
El archivo público `public/integrations/ally-settlement-template-sample.pdf` contiene
únicamente datos ficticios y permite configurar el dominio `finserpay.com` para el
encabezado. Los documentos reales siguen usando exclusivamente la ruta firmada.

## Plantilla Meta

Crear una plantilla de utilidad con parámetros posicionales, encabezado DOCUMENT y
este cuerpo exacto (sin pie ni botones):

> Hola {{1}}. Adjuntamos tu liquidación FINSER PAY del {{2}} al {{3}}. Valor neto de la liquidación: {{4}}. Este documento informa la liquidación generada y no confirma un desembolso.

Parámetros: nombre del aliado, fecha inicial, fecha final, neto formateado en COP.
La aprobación debe ser APPROVED. Meta directo comprueba nombre, idioma, encabezado y
cuerpo antes de enviar. El flujo Dapta utiliza la plantilla aprobada importada y el canal
oficial fijados en su definición; debe mantenerse el mismo cuerpo y orden de parámetros.

Solo para Meta directo, suscribir messages de la app Meta a
/api/integraciones/liquidaciones/whatsapp. Configurar los dos secretos anteriores.
Si la app ya tiene callback para Diana/Dapta, conservarlo: utilizar la suscripción
de app correspondiente o un relay del proveedor que preserve cuerpo y firma Meta.
No reemplazar a ciegas el webhook de otra integración. El evento debe conservar
biz_opaque_callback_data (UUID del intento), recipient_id y metadata.phone_number_id.

## Reintentos y resultados inciertos

La clave UUID del POST se conserva ante pérdida de respuesta y también cuando el
intento ya estaba en cola; repetirla no crea una segunda copia. Un reenvío de un
canal SENT exige confirmación del usuario y una nueva clave. Solo el administrador
central puede solicitarlo. Un fallo de un canal no modifica el otro.

La clave de Resend es ally-settlement/UUID-del-intento. Su idempotencia tiene ventana
de 24 horas. Meta no ofrece esa garantía para este POST. Por tanto, timeout, 5xx,
respuesta sin recibo o caída después de iniciar el envío quedan UNCERTAIN, visibles
como Fallido con explicación y reenvío bloqueado. No se recicla la clave ni se
reintenta automáticamente un resultado incierto.

Meta directo puede resolverlo mediante su webhook firmado; Dapta, mediante un recibo
posterior del mismo flujo dentro de la vigencia de su autorización. Para correo sin recibo,
operaciones debe consultar Resend por la clave y destinatario antes de conciliar:
solo registrar SENT con evidencia del ID real, o FAILED con constancia de que no
se aceptó. Conservar dicha evidencia en la gestión operativa. No desbloquear a ciegas
un resultado incierto. Esta intervención excepcional requiere acceso al proveedor;
la interfaz no permite inventar un envío exitoso.

## Verificación reproducible

- npm run test:settlement-delivery
- npm run prisma:generate con DATABASE_URL ficticia (no se conecta para generar).
- npx tsc --noEmit --incremental false

Pruebas: validación y actualización de contactos, aislamiento por aliado, rollback de
la cola, concurrencia, duplicados, token de reserva caducado, fallo parcial, configuración
incompleta, aceptación sin recibo, historial, PDF congelado, webhook firmado y permisos HTTP.
Los proveedores se inyectan y ningún test usa credenciales reales.
La revisión visual de escritorio y 320 px utiliza respuestas HTTP simuladas.

Resultado de verificación del 21/10/2026: 119/119 pruebas aprobadas, npm run build
completado con TypeScript y 105 páginas estáticas, y ESLint focalizado aprobado.
Ampliación Dapta del 23/10/2026: 171/171 pruebas aprobadas; build de producción,
TypeScript y ESLint focalizado aprobados. Incluye ejecución local de los nodos del
flujo, autorización única, caducidad y manipulación de enlaces, respuestas ambiguas
y carreras entre callback, respuesta del proveedor y timeout. Ningún mensaje real.
La prueba integral usa PostgreSQL embebido, PDFKit real y proveedores simulados;
verifica el mismo PDF por ambos canales, ausencia de duplicados y aislamiento por aliado.
Los instaladores de esquema se probaron en bases aisladas. Las verificaciones locales
no ejecutan migraciones productivas ni envían mensajes. El despliegue ejecuta los
instaladores aditivos mediante railway-predeploy.mjs; conservar
ALLY_SETTLEMENT_DELIVERY_ENABLED=false hasta completar la configuración de ambos canales.

Referencias oficiales: [adjuntos Resend](https://resend.com/docs/dashboard/emails/attachments),
[idempotencia Resend](https://resend.com/docs/dashboard/emails/idempotency-keys),
[dominios Resend](https://resend.com/docs/dashboard/domains/introduction).
