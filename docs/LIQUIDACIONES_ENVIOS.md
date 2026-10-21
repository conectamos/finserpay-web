# Envío de liquidaciones a aliados

Implementación preparada sobre origin/main dd16d957. Los ensayos usan contactos ficticios,
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
no acredita lectura, llegada a bandeja principal ni desembolso. Los errores posteriores
de WhatsApp se concilian mediante webhook firmado.

El PDF usa el generador existente, sin cambiar diseño ni cálculos. El mapeo del snapshot
se comparte entre descarga y envío; el primer PDF enviado queda almacenado con SHA-256
y se reutiliza idéntico para ambos canales y reenvíos. No se publica una URL del PDF.
La carga de medios en Meta es autenticada.

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
| WHATSAPP_SETTLEMENT_ACCESS_TOKEN | Token exclusivo de liquidaciones con permisos whatsapp_business_messaging y whatsapp_business_management sobre el número y WABA oficiales. Si no está definido, usa WHATSAPP_ACCESS_TOKEN sin modificarlo. |
| WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID | 1162059967000416, confirmado para +57 3124085562; se verifica display_phone_number antes de cada envío. Si no está definido, usa WHATSAPP_PHONE_NUMBER_ID. |
| WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID | 2148284059050848, WABA del número oficial y de la plantilla aprobada. Si no está definido, usa WHATSAPP_BUSINESS_ACCOUNT_ID. Se verifica que la cuenta contiene el número. |
| WHATSAPP_GRAPH_API_VERSION | Reutiliza la versión existente; v25.0 por defecto. |
| WHATSAPP_SETTLEMENT_TEMPLATE_NAME | Nombre de la nueva plantilla aprobada con encabezado DOCUMENT. |
| WHATSAPP_SETTLEMENT_TEMPLATE_LANGUAGE | Idioma exacto aprobado, por ejemplo es_CO; no se toma el idioma de otras campañas. |
| WHATSAPP_SETTLEMENT_APP_SECRET | Secreto de la app Meta dedicada al número oficial para verificar firmas del webhook. Si no está definido, usa WHATSAPP_APP_SECRET. |
| WHATSAPP_SETTLEMENT_VERIFY_TOKEN | Secreto aleatorio de al menos 32 caracteres para verificar la suscripción del webhook. |

Todas las credenciales deben almacenarse en variables servidor, nunca NEXT_PUBLIC.
Las variables WHATSAPP_SETTLEMENT_* tienen prioridad únicamente para liquidaciones;
no se escriben ni cambian las variables compartidas ni las integraciones existentes.
Una variable dedicada definida pero vacía o inválida bloquea su operación: no se
reemplaza silenciosamente por el valor compartido. Una configuración parcial sigue
obligada a demostrar el número oficial, su pertenencia al WABA y la plantilla aprobada.
El webhook usa el mismo PHONE_NUMBER_ID efectivo que el envío y rechaza firmas del
secreto compartido cuando existe WHATSAPP_SETTLEMENT_APP_SECRET.
El remitente de correo está fijado en FINSER PAY <pagos@finserpay.com>.
El adaptador verifica que Resend tenga finserpay.com verificado y envío habilitado;
no sustituye el remitente por otro dominio. La presencia de una clave no se considera
prueba de autorización.

La auditoría inicial encontró claves básicas de Resend y Meta en Railway y 14 plantillas
sin liquidaciones ni encabezados DOCUMENT. La revisión posterior confirmó el número
oficial +57 3124085562 en PHONE_NUMBER_ID 1162059967000416 y WABA 2148284059050848.
La integración compartida productiva usa +57 3113539730 y su token no tiene acceso
al número oficial de liquidaciones; se conservan sus variables. Railway tiene ahora
los IDs dedicados y ALLY_SETTLEMENT_DELIVERY_ENABLED=false.
Resend se verificó mediante la clave existente: dominio finserpay.com, estado verified,
capabilities.sending=enabled e ID 1b0966af-1f99-48ca-8f92-870f3c92d47a, guardado en
RESEND_SETTLEMENT_DOMAIN_ID. No se envió correo para comprobarlo.
El token de verificación del webhook se generó y almacenó directamente en Railway.
La activación sigue requiriendo un token Meta con acceso al WABA oficial, la plantilla
aprobada, el secreto de su app y una suscripción compatible con el callback actual de Dapta.

## Plantilla Meta

Crear una plantilla de utilidad con parámetros posicionales, encabezado DOCUMENT y
este cuerpo exacto (sin pie ni botones):

> Hola {{1}}. Adjuntamos tu liquidación FINSER PAY del {{2}} al {{3}}. Valor neto de la liquidación: {{4}}. Este documento informa la liquidación generada y no confirma un desembolso.

Parámetros: nombre del aliado, fecha inicial, fecha final, neto formateado en COP.
La aprobación debe ser APPROVED; el servidor comprueba nombre, idioma, encabezado y
cuerpo aprobado antes de cargar o enviar el PDF.

Suscribir messages de la app Meta a
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

WhatsApp puede resolverlo mediante su webhook firmado. Para correo sin recibo,
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

Resultado de verificación del 21/10/2026: 114/114 pruebas aprobadas, npm run build
completado con TypeScript y 105 páginas estáticas, y ESLint focalizado aprobado.
La prueba integral usa PostgreSQL embebido, PDFKit real y proveedores simulados;
verifica el mismo PDF por ambos canales, ausencia de duplicados y aislamiento por aliado.
Los instaladores de esquema se probaron en bases aisladas. No se ejecutaron migraciones
en producción, no se desplegó esta rama y no se activaron credenciales ni envíos reales.

Referencias oficiales: [adjuntos Resend](https://resend.com/docs/dashboard/emails/attachments),
[idempotencia Resend](https://resend.com/docs/dashboard/emails/idempotency-keys),
[dominios Resend](https://resend.com/docs/dashboard/domains/introduction).
