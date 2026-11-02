# Atención: operación del canal directo de Meta

Revisión: 30 de octubre de 2026. La operación directa de Meta descrita a continuación cuenta con pruebas productivas previas. La fase de filtros, lecturas por usuario, agenda y plantillas manuales, con once tablas de Atención, quedó publicada en el despliegue Railway `2806377b-7260-4ba6-9af6-bceb820f3c12`, commit `463fe910e5cac6ca9a2a712684665a1426f5d019`. La ampliación de plantillas de cartera no requiere tablas nuevas y conserva una validación de despliegue separada. La ampliación posterior del tablero lleva el esquema a doce tablas; el tablero y el cierre conjunto están implementados para validación, sin afirmar aquí su despliegue ni una ejecución productiva.

La aplicación Meta `1128613623424831` está publicada, con credenciales dedicadas configuradas en Railway, callback verificado y suscripción a mensajes confirmada. Se comprobó la recepción real de texto, imagen, audio y video en el CRM, conservando el chat existente y su analista; los medios de prueba cargaron y se reprodujeron mediante rutas privadas. La respuesta humana de texto autorizada se envió una sola vez y quedó Entregado en el CRM tras los recibos del webhook. Diana permanece en pausa en la línea autorizada y ambos indicadores de envío están activos en producción. Dapta conserva su suscripción; siguen pendientes el traspaso automático por conversación, su integración como motor de IA, los adjuntos históricos y la prueba de envío multimedia.

## Actualización de Diana del 1 de noviembre de 2026

El propietario autorizó reanudar a Diana con control manual del traspaso en
Dapta. La línea mostró respuestas activas y el propietario confirmó una respuesta
real. La pausa descrita en los apartados históricos del 30 de octubre queda
superada por esta autorización. El cierre desde el CRM permanece independiente
del agente: asignar o finalizar aquí no confirma una pausa remota.

La consulta financiera de Diana añade cantidades de cuotas vigentes, total
monetario pendiente y capital para liquidar hoy, utilizando los cálculos del
portal y conservando la elegibilidad actual. La siguiente cuota no fija la
vigencia de una cotización. Se actualizaron las instrucciones para información
pública sin cédula y reutilización de la ya consultada en la misma conversación.
El reconocimiento automático por cédula del CRM y el envío de recibos por la IA
requieren todavía un contexto autenticado y su propia integración.

El puente de eventos nativos y sus límites se describen en
[ATENCION_DAPTA.md](ATENCION_DAPTA.md#respuestas-de-diana-mediante-eventos-nativos).

## Estado operativo confirmado al 30 de octubre de 2026

- **Aplicación y acceso:** Atención `1128613623424831`, publicada en el negocio Finser PAY `1109745271496382`. Usuario de sistema `61595750474386`, tipo Employee, con acceso Desarrollar a la aplicación y acceso Todo a la cuenta de mensajería vinculada `2148284059050848`, autorizados por el propietario.
- **Credenciales:** token permanente con `whatsapp_business_messaging` y `whatsapp_business_management` guardado en Railway. `WHATSAPP_ATTENTION_ACCESS_TOKEN`, `WHATSAPP_ATTENTION_APP_SECRET` y `WHATSAPP_ATTENTION_VERIFY_TOKEN` están configuradas. Los IDs estrictos del número y de la cuenta de mensajería se conservaron; no se documentan valores secretos.
- **Identidad comprobada:** las lecturas Graph v26 confirmaron Phone Number ID `1162059967000416`, número `+573124085562` y nombre verificado Finser PAY. La cuenta de mensajería `2148284059050848` devolvió únicamente ese número. La interfaz distingue la cuenta WhatsApp `1647162566997935` de su cuenta de mensajería vinculada `2148284059050848`; no deben intercambiarse esos IDs.
- **Webhook y suscripciones:** Meta verificó `https://finserpay.com/api/integraciones/atencion/whatsapp` y quedó suscrito el campo `messages` en v26. La lectura de `subscribed_apps` mostró inicialmente Dapta `1109377124599528` y después Atención `1128613623424831` junto con Dapta, cuya suscripción se preservó.
- **Enrutamiento:** la consulta `routing_roles` respondió HTTP 400, código 100, «Conversation routing is not enabled». No se habilitó ni se incorporó al contrato del CRM. La [documentación oficial de Conversation Routing de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/thread-control) queda como referencia de una alternativa, sin acreditar disponibilidad para esta línea ni control de la IA.
- **Evidencia de despliegue de la prueba inicial:** código y esquema base en commit `fba3f60c69fe880e11c87696edc311e9e9ee538a`; actualización de privacidad en `34060e6e`. El despliegue `a26a71e3-e325-4821-8780-47a7400e32a3` reutilizó el build de `34060e6e` para aplicar los indicadores de prueba, con estado SUCCESS actualizado a `2026-10-30T17:02:40.854Z`. Esta evidencia no acredita el despliegue de la nueva fase operativa ni de sus plantillas manuales.
- **Prueba humana:** respuesta de texto autorizada enviada una sola vez, aceptada por WhatsApp y confirmada como Entregado en el CRM. Diana permanece en pausa y ambos indicadores están activos.
- **Pendiente:** traspaso automático entre IA y personas, integración de Dapta exclusivamente como motor de IA, recuperación de adjuntos históricos de Dapta y prueba de envío multimedia.

## Pausa temporal y prueba humana autorizada

Con autorización del propietario se pausaron las respuestas de Diana desde Canales → WhatsApp, en la línea `+573124085562`. Dapta confirmó la pausa y la registró el 30 de octubre a las 12:00 en su auditoría. Tras recargar el listado, el estado En pausa persistió y las conversaciones iniciadas por la empresa figuraron como No disponibles. Se conservaron número, agente y suscripción. La pausa permanece hasta que el propietario indique reanudar.

En Railway se guardaron `WHATSAPP_ATTENTION_SEND_ENABLED=true` y `WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED=true` mediante `skipDeploys`, y después se completó el redespliegue indicado arriba. El GET administrativo de `/api/atencion/integration` confirmó `configured=true`, `webhookReady=true`, `sendEnabled=true`, `cutoverConfirmed=true`, `canSend=true` y `missing=[]`, con coincidencia exacta del número y la cuenta de mensajería autorizados. El campo de respuesta quedó habilitado en el CRM.

La entrada «Prueba CRM sin Diana» llegó a las 12:03 de Bogotá al chat existente. A las 12:04 se envió una única vez, exclusivamente a ese mismo chat, el texto autorizado «Prueba de respuesta humana desde el CRM de FINSER PAY». La interfaz atribuyó el mensaje a Administrador, confirmó su aceptación por WhatsApp y, al actualizar tras los recibos del webhook, mostró Entregado. El compositor quedó vacío y habilitado. La prueba de aceptación y entrega del texto quedó completada; no incluye envío de archivos multimedia.

Los logs registraron POST del webhook con HTTP 200 a `2026-10-30T17:03:49.393955999Z`, `2026-10-30T17:04:32.297268276Z` y `2026-10-30T17:04:32.878449305Z`; la entrega se confirmó mediante el estado del mismo mensaje en el CRM. No se documentan el teléfono personal ni identificadores del cliente. La pausa es global para las respuestas de Diana en esta línea; no implementa un traspaso automático entre IA y personas por conversación ni modifica las suscripciones de Meta.

## Consulta de soporte sobre Conversation Routing

El 30 de octubre de 2026 se envió, con autorización del propietario, una consulta al asistente para empresas de Meta AI desde Business Support Home. Se incluyeron únicamente la línea empresarial, IDs de negocio/cuentas/apps, el error 100 de `routing_roles` y su referencia de diagnóstico; no se compartieron claves ni chats de clientes. La respuesta automática recomendó solicitar revisión técnica de la disponibilidad del enrutamiento. No acreditó una activación, una incompatibilidad de coexistencia ni la creación de un caso atendido por una persona.

Se comprobó también el acceso autenticado a [Meta Developer Support](https://developers.facebook.com/support/) y a [Informar de un error](https://developers.facebook.com/support/bugs/report/). El formulario de reporte denegó acceso e indicó como requisitos una cuenta de desarrollador registrada y un rol administrador/desarrollador en una aplicación con más de 24 horas de antigüedad. La aplicación de Atención se creó ese mismo día. No se envió un reporte por ese formulario. También se revisó la página de Business Support Home del portfolio `1109745271496382`: no mostró una opción de crear caso en la interfaz disponible.

El propietario aprobó expresamente el seguimiento al mismo asistente de Meta AI para solicitar derivación humana o apertura de caso con los mismos datos, así como documentación sobre coexistencia y enrutamiento, sin cambios en la cuenta. El seguimiento se envió: se comprobó que el texto apareció en el historial y que el compositor quedó vacío.

Meta AI pidió confirmar el activo. Dentro de la misma autorización se enviaron de nuevo el portfolio `1109745271496382`, la cuenta de mensajería `2148284059050848`, el Phone Number ID `1162059967000416` y la línea empresarial `+573124085562`. Se reiteró que la solicitud se limita a consulta/apertura de caso, sin habilitar cambios, y se pidió número de caso y canal de seguimiento. El asistente rectificó que el error 100 no demuestra incompatibilidad de coexistencia y no aportó una matriz documentada que acreditara ese bloqueo.

En su respuesta final, Meta AI aclaró expresamente que ese chat no puede abrir directamente el caso técnico ni generar un número de seguimiento. Recomendó buscar Crear caso en Business Support Home, seleccionando primero el portfolio y la WABA, o hacerlo a nivel de portfolio si esa opción no aparece en la WABA. Esta recomendación no confirma que la opción esté disponible en la cuenta. No se creó un caso, no se conectó una persona de soporte y no se activó el enrutamiento. Ninguna de estas consultas cambia el número, las suscripciones, los permisos, los indicadores de envío o el funcionamiento de Diana.

## Prueba operativa de recepción y medios

El 30 de octubre de 2026, antes de habilitar el envío humano, un mensaje de prueba enviado por el propietario llegó al chat existente y conservó su asignación al analista. El diagnóstico productivo `GET /api/atencion/integration`, con sesión administrativa, confirmó configuración, webhook y coincidencia exacta con la línea principal autorizada, sin variables faltantes.

En el despliegue Railway `c87ff0eb-233f-4d09-a812-0fec0f1d5f05` se observaron POST del webhook con HTTP 200 desde `2026-10-30T16:30:36Z`. A las 11:33 de Bogotá se enviaron imagen, audio y video de prueba, con estos resultados en los elementos nativos del navegador:

| Medio | Resultado comprobado |
| --- | --- |
| Imagen | Imagen de 1080 px cargada; `complete=true` |
| Audio | Reproducción hasta completar 3,7465 segundos; `readyState=4`, `error=null` |
| Video | Reproducción hasta completar 2,6 segundos, resolución 576 × 1024; `readyState=4`, `error=null` |

Los medios se obtuvieron por `/api/atencion/{id}/messages/{messageId}/media`. Esta evidencia corresponde a los archivos de prueba recibidos; no incluye teléfonos personales, identificadores de clientes ni contenido de los medios. El envío de texto se confirmó por separado en la prueba humana anterior; el envío multimedia, el traspaso de IA y la recuperación retroactiva de adjuntos del histórico Dapta siguen pendientes.

## Identidad y configuración

El adaptador `lib/atencion-meta.ts` acepta exclusivamente esta línea, conservando el número actual:

| Dato | Valor esperado |
| --- | --- |
| Número | `+573124085562` |
| Phone Number ID | `1162059967000416` |
| WhatsApp Business Account ID | `2148284059050848` |

Las siguientes variables se configuran únicamente en el servidor. No deben llevar prefijo `NEXT_PUBLIC_` ni guardarse en el repositorio, capturas o logs.

| Variable | Uso |
| --- | --- |
| `WHATSAPP_ATTENTION_ACCESS_TOKEN` | Token de la aplicación/usuario de sistema con acceso a esta WABA y línea |
| `WHATSAPP_ATTENTION_APP_SECRET` | Secreto de la aplicación que firma los eventos |
| `WHATSAPP_ATTENTION_VERIFY_TOKEN` | Secreto propio para el desafío inicial del webhook |
| `WHATSAPP_ATTENTION_PHONE_NUMBER_ID` | Debe coincidir exactamente con el Phone Number ID anterior |
| `WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID` | Debe coincidir exactamente con la WABA anterior |
| `WHATSAPP_GRAPH_API_VERSION` | Versión explícita compatible de Graph, con formato `vNN.0`; esta variable también existe en otras integraciones |
| `WHATSAPP_ATTENTION_SEND_ENABLED` | Mantener `false` durante preparación y recepción en sombra |
| `WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED` | Mantener `false` hasta verificar el control efectivo de la IA |

El código no toma como alternativa las credenciales generales de OTP ni las de liquidaciones. Establecer ambos indicadores en `true` permite evaluar el envío; no configura ni pausa Dapta por sí mismo. La etiqueta local `human_requested` tampoco confirma una pausa remota.

El token necesita los permisos de Meta `whatsapp_business_messaging` para mensajería y medios, y `whatsapp_business_management` para las operaciones de administración utilizadas al preparar/verificar la WABA. Deben comprobarse además su vigencia y el acceso al activo concreto. Las consultas al portfolio empresarial pueden requerir `business_management`; no es una razón para ampliar permisos indiscriminadamente. Véase la [colección oficial de Meta para Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-eb9a6721-1056-4db2-b00a-2290e04b5b5d).

`GET /api/atencion/integration`, con sesión de administración central, muestra faltantes sin devolver secretos. Cuando la configuración está completa, realiza lecturas Graph del número y de los números de la WABA, y exige coincidencia del ID, la pertenencia a la WABA y el número visible. `configured` solo describe configuración; la comprobación de red y la recepción real deben verificarse por separado.

## Mensajes enviados desde WhatsApp Business del celular

El webhook procesa `smb_message_echoes` por separado de `messages`. Un eco válido guarda el mensaje como saliente con autor «WhatsApp Business», incluyendo los adjuntos admitidos por Meta. No atribuye al analista los mensajes que escribió alguien desde el celular, no los vuelve a enviar y no abre ni prolonga la ventana de respuesta de 24 horas.

Se verifica la firma, WABA, Phone Number ID, remitente empresarial y destinatario individual. La deduplicación utiliza el ámbito del canal y el identificador de WhatsApp; si el mensaje ya existe, conserva su autor y contenido. Para vincular un historial anterior se exige un único chat con el teléfono exacto y sin un vínculo contradictorio. Se conservan la asignación, el estado de cierre y el modo de atención. Los cambios alimentan el canal de actualización en tiempo real existente.

Además del despliegue se debe comprobar la suscripción `smb_message_echoes` en la aplicación de Atención, junto a `messages`. La prueba de aceptación requiere enviar un mensaje nuevo desde WhatsApp Business del celular y observarlo en su chat del CRM. Este soporte no recupera retroactivamente mensajes que Meta no haya entregado, ni habilita grupos. Un historial importado de Dapta sin vínculo muestra ese estado; un chat vinculado sin mensaje entrante muestra por separado que aún no existe una ventana de respuesta.

## Webhook y activación gradual

La ruta implementada es `GET/POST /api/integraciones/atencion/whatsapp`. En el dominio principal, el callback es:

```text
https://finserpay.com/api/integraciones/atencion/whatsapp
```

Debe apuntar directamente al despliegue HTTPS correcto. El GET responde al desafío `hub.mode=subscribe`, valida el verify token y rechaza parámetros repetidos. El POST verifica `X-Hub-Signature-256` con HMAC SHA-256 sobre los bytes originales antes de interpretar JSON, limita el cuerpo a 1 MiB y procesa únicamente `object=whatsapp_business_account`, campos `messages` y `smb_message_echoes`, WABA y Phone Number ID autorizados. Un error de persistencia no recibe un éxito ficticio, también cuando el evento contiene solo ecos.

Preparar el callback de la aplicación y su suscripción a la WABA son pasos distintos. El mecanismo documentado es `/{WABA-ID}/subscribed_apps`; comprobar primero la aplicación y las suscripciones existentes evita confundir la aplicación de Atención con Dapta. No eliminar suscripciones ajenas ni sobrescribir su callback como parte de esta preparación. La aplicación no ejecuta automáticamente esos cambios. Referencia: [suscripción de aplicación a WABA, Meta](https://www.postman.com/meta/whatsapp-business-platform/request/26gui66/subscribe-to-a-waba?sideView=variables&tab=overview).

Secuencia operativa:

1. Desplegar el esquema y código con ambos indicadores de envío en `false`.
2. Terminar la aplicación y sus credenciales dedicadas; comprobar la identidad con el diagnóstico central.
3. Verificar el desafío, suscripción y recepción real de un mensaje autorizado en la línea existente. Confirmar persistencia, adjunto privado, deduplicación y atribución `SYSTEM_META`.
4. Verificar externamente que Dapta no contestará simultáneamente por el mismo canal y que su eventual uso como motor de IA tiene un contrato productivo probado. Una solicitud local de atención humana no cumple este paso.
5. Solo después de esa evidencia, habilitar ambos indicadores y validar un intercambio autorizado, con su confirmación Meta y estados de entrega. No hay campaña ni envío automático al habilitarlos.

Para detener nuevas respuestas se establece `WHATSAPP_ATTENTION_SEND_ENABLED=false`. Esto no revoca un POST que Meta ya recibió, no borra el outbox y no reactiva Dapta. Se deben seguir reconciliando las confirmaciones pendientes.

## Persistencia y despliegue

La cadena real del repositorio es `railway.toml` → `node scripts/railway-predeploy.mjs` → `ensure-atencion-schema.mjs` → `setup-atencion.sql`. Atención se instala al final de los demás instaladores; un fallo anterior impide llegar a su instalación. No basta con que el build termine correctamente.

El Dockerfile incluye expresamente los tres archivos de esa cadena en el runner y copia las dependencias PostgreSQL necesarias. El arranque es `node server.js`. El instalador toma un advisory lock, valida la estructura previa, ejecuta SQL transaccional en `public` y verifica doce tablas, columnas, claves, auditoría inmutable y los cuatro disparadores de eventos. También verifica el índice único de nombres de secciones activas. El comando manual equivalente es `npm run db:setup-atencion`, con `DATABASE_URL` solo en el entorno del servidor. No se ejecuta DDL desde solicitudes web.

La actualización conserva las siete tablas originales y las tablas Meta `AttentionMetaBinding`, `AttentionMetaOutbox` y `AttentionMetaDelivery`. `AttentionReadState` guarda la lectura por usuario nominal e identificador entrante; no altera el mensaje ni la versión de negocio del chat. La columna JSONB nullable `AttentionMetaOutbox.template` fija la definición y los parámetros de la plantilla autorizada. El tablero añade `AttentionBoardSection`, `AttentionConversation.sectionId` nullable y `boardVersion` independiente, inicialmente uno. Estas ampliaciones son aditivas e idempotentes. `AttentionAudit` admite un usuario real o el actor de sistema explícito `SYSTEM_META`; su trigger sigue impidiendo UPDATE y DELETE. La identidad Meta `(phoneNumberId, wamid)` y la identidad externa de Dapta se almacenan por separado. El esquema financiero no cambia.

Los datos durables residen en PostgreSQL, no en el sistema de archivos del contenedor. Reiniciar/reemplazar el runner no elimina conversaciones u outbox si se conserva la misma base. La base guarda referencias de medios y metadatos; los bytes se descargan de Meta bajo autorización cuando se solicitan. No hay un archivo permanente de adjuntos ni garantía de conservación indefinida del proveedor. No se necesita un volumen Docker para esta implementación. Las tablas se administran por este SQL, sin agregarlas a Prisma ni sustituir su instalación por `prisma db push`.

El instalador debe completar y verificar las doce tablas antes de ejecutar esta versión. Sin `AttentionReadState`, la bandeja señala preparación pendiente y el detalle rechaza la consulta de forma controlada; sin la columna `template`, el envío manual de plantillas permanece bloqueado. Las rutas del tablero devuelven preparación pendiente si faltan su tabla o columnas, sin intentar instalarlas. Un rollback de aplicación debe conservar un instalador compatible con el esquema ampliado; no se deben borrar tablas o mensajes para adaptar la base a un binario anterior.

## Bandeja, lecturas y agenda

Los filtros No leídos, Sin responder, Sin asignar y etiqueta se calculan dentro del alcance central o del analista asignado. Las etiquetas disponibles también respetan ese alcance; `FINSERPAY` procede de la clasificación financiera segura. La interfaz tipo WhatsApp Web conserva los componentes y la identidad visual de FINSER PAY; la operación se describe en [Atención CRM](ATENCION_CRM.md).

`POST /api/atencion/{id}/read` recibe hasta 500 `messageIds` entrantes observados, valida que pertenezcan al chat autorizado y registra solo las lecturas nuevas del usuario actual. La interfaz lo solicita únicamente con el chat visible y al final del historial cargado. No utiliza la hora del navegador ni marca mensajes concurrentes ausentes del cuerpo. La lectura no envía recibos a Meta, no incrementa la versión del chat y no crea una marca compartida entre analistas. El historial que queda fuera del detalle cargado puede conservar no leídos; no se presume leído.

Los contadores de no leídos y sin responder cuentan chats; cada chat incluye además su número de mensajes no leídos. La espera usa la primera entrada posterior a la última salida acreditada: estados `queued`, `sending`, `failed` o `uncertain` no la despejan. Una salida aceptada, enviada, entregada o leída, o una salida histórica registrada sin estado de entrega, sí cuenta como respuesta. No hay umbral de SLA inventado.

`GET /api/atencion/agenda?filter=today|overdue|upcoming|all&page=1` devuelve tareas pendientes y sus totales, con páginas de cuarenta. Las fechas se clasifican por día calendario de Bogotá; Todas incluye las tareas sin fecha. Completar utiliza la mutación existente con versión y UUID. Los avisos de agenda son internos, sin notificaciones externas. La confirmación de lecturas registra auditoría y un único `pg_notify` solo cuando añade filas; el evento incorpora `readActorUserId` para refrescar únicamente conexiones del mismo usuario. Se conserva la auditoría existente de consultas.

### Lectura compartida del equipo

La bandeja combina las lecturas nominales anteriores con `AttentionTeamReadState`, sin atribuir a cada analista una lectura personal que no realizó. Una respuesta nueva confirmada mediante `smb_message_echoes` del celular despeja para el equipo únicamente los mensajes entrantes anteriores a su fecha. Un estado `read` de salida, un mensaje de IA o una salida originada en el propio CRM no equivalen a esa evidencia. Leer el chat en el celular sin responder no activa esta regla. Las entradas del mismo segundo se conservan sin leer cuando no es posible acreditar su orden.

El menú «Gestionar conversación» incluye «Marcar como leído para el equipo». `POST /api/atencion/{id}/read/team` recibe exclusivamente `version` y `requestId`; comprueba usuario, alcance, versión y la reserva idempotente bajo bloqueo. Marca los mensajes entrantes existentes al confirmar, incluidos los de un historial no cargado completo; una nueva entrada que cambie la versión exige revisar el chat antes de volver a pulsar. Un replay no absorbe mensajes nuevos. La acción no envía mensajes ni recibos a Meta, no finaliza ni reasigna y no modifica la versión de negocio.

Ambos orígenes conservan auditoría e invalidan la bandeja de los usuarios actualmente autorizados. La instalación es aditiva y no marca retrospectivamente todo el histórico como leído. El cierre conjunto excluye las lecturas compartidas de su revisión y recuento.

## Tablero y eventos de configuración

`GET /api/atencion/board?search=` devuelve Sin sección permanente y las secciones activas, con conteos dentro del alcance nominal. `count` aplica la búsqueda; `totalCount` mantiene el mismo alcance sin búsqueda. `GET /api/atencion/board/cards?sectionId=none|UUID&search=&page=1` devuelve veinte tarjetas por página, ordenadas por contacto real. No carga el histórico completo para construir el tablero.

`GET /api/atencion/:id/section` consulta la ubicación desde la ficha de un chat autorizado. Devuelve `conversationId`, `sectionId`, `boardVersion`, las secciones activas (incluida Sin sección) y `permissions.move`. Revalida la sesión y el alcance del chat antes de listar secciones; no devuelve contenido ni registra lecturas. El selector usa el mismo `POST /api/atencion/:id/section` del tablero, con su UUID y versión de organización independientes.

Administración central configura columnas mediante `PATCH /api/atencion/board`, con UUID de solicitud y versiones para renombrar, cambiar color, reordenar o archivar. Se admiten hasta veinte secciones, colores `green`, `lime`, `amber`, `slate` y `navy`, y nombres activos únicos. Archivar exige cero chats en toda la sección; no depende de la búsqueda. La instalación crea FINSER PAY, SUMASPAY, BOGOTA, ADDI y OTROS con IDs determinísticos solamente si la tabla está vacía, incluyendo las filas archivadas al comprobarlo. No restaura nombres ni mueve conversaciones existentes.

`POST /api/atencion/{id}/section` recibe `sectionId` nullable, `boardVersion` y `requestId`. Revalida el usuario y el alcance actual: central puede mover todos los chats y el analista únicamente los que tiene asignados. La operación modifica la sección y `boardVersion`, conservando `version`, `lastContactAt`, estado, asignación, etiquetas y condiciones del outbox. La organización manual en FINSER PAY no altera la clasificación financiera automática `FINSERPAY`.

La configuración usa un bloqueo transaccional compartido con los movimientos para impedir archivar una sección mientras recibe un chat. Las solicitudes son idempotentes y los cambios se auditan. El disparador `attention_realtime_board` emite únicamente `{"type":"board"}` al canal existente; el servidor revalida la cuenta antes de invalidar la configuración. No publica nombres de columnas, IDs de chats ni datos personales. Los movimientos reutilizan la notificación de conversación y su alcance nominal.

## Cierre conjunto administrativo

`GET /api/atencion/close-all?cutoff=ISO` prepara una revisión privada del administrador central. El corte debe encontrarse dentro de las últimas 24 horas y no estar en el futuro; la revisión caduca en diez minutos. El resumen muestra chats abiertos, candidatos al cierre, omitidos y mensajes entrantes que se marcarían como leídos. Los IDs observados y sus huellas permanecen en la auditoría del servidor. Se limita la revisión a diez mil chats y doscientos cincuenta mil mensajes sin leer; excederlo produce un rechazo controlado.

`POST /api/atencion/close-all` exige `reviewToken`, `requestId` y `confirmed=true`, origen válido y la misma cuenta central actualmente autorizada. Bajo bloqueo vuelve a comprobar versión, mensajes entrantes, actividad posterior al corte y outbox sin resolver. Solo finaliza candidatos que siguen cumpliendo la revisión; usa `closedAt=cutoff` para conservar la posibilidad de reapertura ante una entrada posterior. Las asignaciones, secciones, etiquetas e historial permanecen intactos.

La marca de lectura incluye únicamente IDs entrantes capturados en la revisión y con fecha anterior o igual al corte, para el administrador que confirma. Incluso cuando un chat deba conservarse abierto, puede marcar sus mensajes antiguos expresamente revisados; los nuevos no se añaden a la revisión por suposición. No modifica lecturas de otros usuarios ni envía recibos a WhatsApp. El cierre, las lecturas y la auditoría se confirman atómicamente; un replay con el mismo UUID devuelve el resultado guardado. Los eventos de lectura se dirigen al actor nominal y los cierres conservan las invalidaciones normales de conversación. No hay llamadas ni envíos al proveedor en esta operación.

## Respuesta humana y recuperación

La verificación del número dedicado y la primera página de números de su cuenta se consultan en paralelo. El adaptador privado de cada petición reutiliza únicamente una comprobación exitosa durante un máximo de cinco segundos, vinculada al token, versión Graph, Phone Number ID y WABA exactos. No comparte caché entre peticiones ni guarda errores; una rotación, cambio de configuración o vencimiento exige otra verificación. Esto evita repetir las dos consultas en la secuencia habitual de subir un archivo y enviarlo, manteniendo los controles de habilitación, destinatario, ventana y reserva antes del POST.

Las lecturas GET transitorias a Meta tienen como máximo dos intentos, con una pausa de 250 ms y dentro del mismo presupuesto de espera original (veinte segundos por defecto). Solo se recuperan errores marcados como reintentables; no se reintentan respuestas inválidas, rechazos de permisos ni ningún POST, incluidas cargas, mensajes y plantillas. El presupuesto también limita una respuesta cuyo cuerpo deje de avanzar. Los diagnósticos de transporte y recuperación usan únicamente etapa, causa técnica permitida y número de intento; no contienen tokens, URLs, destinatarios ni texto del cliente.

Los fallos definitivos del outbox muestran una explicación fija según su código guardado. Una caída previa de conexión se distingue de un archivo incompatible o de una ventana cerrada; los códigos desconocidos conservan un aviso genérico. La incertidumbre mantiene la indicación de consultar sin reenviar. Esto también mejora la presentación de intentos anteriores, sin cambiar sus registros, reabrirlos ni enviarlos de nuevo.

Administración central supervisa la bandeja global. Los analistas nominales activos solo pueden leer/responder en conversaciones asignadas a su identidad; las cuentas de vendedor, supervisor, aliado o enlaces compartidos no reciben acceso. El servidor revalida el rol y la asignación en la transacción y antes del POST. Para descargar medios vuelve a comprobar el acceso después de la lectura de red.

Cada respuesta de texto libre o archivo exige una ventana abierta de 24 horas desde el último inbound nativo validado. El histórico Dapta no abre esa ventana. Las plantillas manuales aprobadas usan el flujo separado descrito a continuación y no habilitan texto libre fuera de ventana. El texto libre admite hasta 4096 caracteres; las descripciones de imagen, video o PDF admiten hasta 1024. Audio y sticker no admiten descripción en este flujo.

`POST /api/atencion/{id}/messages` recibe multipart con `requestId`, `version`, `text` y un `file` opcional. La intención se guarda antes de subir/enviar. Una única reserva de 120 segundos autoriza el trabajo; una segunda llamada no obtiene esa reserva. Antes del POST se revalidan alcance, versión, canal, ventana, indicadores y adjunto cargado. Hay como máximo una intención no resuelta por conversación.

| Estado | Interpretación operativa |
| --- | --- |
| `queued` | Intención guardada; no prueba que Meta la recibió |
| `sending` | Se autorizó iniciar el POST; esperar confirmación |
| `accepted` | Meta devolvió un `wamid`; no significa entregado |
| `sent`, `delivered`, `read` | Evidencia recibida del proveedor |
| `failed` | Fallo definitivo o cancelación anterior al POST; no se reintenta automáticamente |
| `uncertain` | Puede haberse enviado; no crear un envío sustituto ni reintentar automáticamente |

`GET /api/atencion/{id}/messages?requestId={uuid}` consulta la intención del actor. Recupera una reserva abandonada: antes del POST queda fallida; después de iniciarlo queda incierta. El callback correlaciona `biz_opaque_callback_data` con el UUID interno del outbox, además de comprobar canal, destinatario y `wamid`. Los recibos pueden reconciliar una respuesta perdida y no degradan una lectura confirmada.

Un GET sin resultado no demuestra que el POST original se canceló. `DELETE` sobre esa misma URL registra una cancelación persistente por actor/requestId que bloquea un POST atrasado. Solo permite cancelar antes del inicio del POST; un envío iniciado, incierto o aceptado devuelve conflicto. Se conservan intención y auditoría, y una nueva intención requiere otro UUID.

## Plantillas manuales aprobadas

`GET /api/atencion/{id}/templates` consulta el catálogo vivo de la WABA autorizada tras comprobar el acceso al chat. Solo expone definiciones `APPROVED`, sin IDs privados de Meta. Muestra deshabilitadas las estructuras no admitidas y vuelve a comprobar el acceso después de la lectura de red. `POST` sobre la misma ruta exige `requestId`, `version`, `templateKey`, `revision`, los `parameters` exactos y `confirmed=true`; el cliente no puede aportar una definición, destinatario, URL multimedia ni contenido arbitrario para sustituir la plantilla.

Se admiten categorías Utility y Marketing con variables posicionales, cuerpo y encabezado de texto, pie, y hasta tres botones de respuesta rápida o URL. Los enlaces dinámicos admiten únicamente un sufijo validado; los botones de respuesta rápida generan una carga controlada por el servidor. La excepción de imagen es el encabezado configurado de `2dias`: se valida y carga mediante el servidor, sin aceptar URLs ni adjuntos del cliente. No se habilitan autenticación, variables con nombre ni otros formatos multimedia o tipos de botones. La interfaz presenta vista previa, revisión del destinatario y confirmación antes del envío.

Las definiciones `2dias`, `1_dia_falta`, `hoyvence`, `fechap` y `data` incluyen candidatos financieros calculados para la identidad verificada del chat. Cada candidato muestra crédito, cuota, vencimiento, día de revisión, parámetros generados y motivo de bloqueo cuando corresponda. `data` muestra además los créditos cubiertos por el aviso. El POST financiero exige `creditId`, `financialRevision` y `parameters: {}`: se recalcula el contenido y se rechaza una revisión desactualizada, un crédito ajeno o parámetros introducidos por el cliente.

Se reutilizan las políticas del calendario y los registros `CreditDueReminder` y `CreditOverdueDataRecipient/Attempt/Coverage`. `fechap` comparte la reserva de `hoyvence`; la interfaz manual no puede repetir un aviso ya reservado por el cron, ni el cron uno reservado manualmente. El historial nominal se vincula con `CreditCollectionCommunicationEvent`. Se revalidan pagos, protecciones de mora, horario, identidad y fecha inmediatamente antes del único POST. Las consultas web no instalan esquemas.

El selector mantiene `bienvenida` y `liquidacion_aliado*` en sus procesos específicos. `cuotavencida` y `vencido` anuncian una restricción programada dentro de treinta minutos; su envío libre por mora no está habilitado. `bloqueo` requiere el proceso que verifica la restricción. Seleccionar una plantilla no programa ni ejecuta acciones sobre dispositivos.

El servidor guarda la definición y sus parámetros en el outbox humano con la huella del chat, versión, plantilla y revisión. Antes del único POST vuelve a leer el catálogo, exige aprobación y revisión idénticas, y revalida usuario, asignación, destinatario, reserva e indicadores de envío/control de IA. Un replay conserva el resultado; una respuesta de red incierta no se reenvía automáticamente. La consulta y cancelación usan las mismas rutas por `requestId` del outbox humano.

El envío de una plantilla no exige una ventana de 24 horas, pero tampoco la abre ni modifica `metaLastInboundAt`. Para un chat histórico sin vínculo Meta se exige teléfono internacional exacto, un único chat coincidente y ausencia de vínculos contradictorios; la creación del vínculo se audita y conserva asignación, cierre e historial. Esta fase no cambia la pausa de Diana ni las automatizaciones existentes. Su validación local no acredita todavía un envío real de plantilla manual.

## Archivos e histórico

Estos son los formatos y límites de envío de esta aplicación; pueden ser más restrictivos que los admitidos por Meta:

| Tipo | Formatos admitidos | Máximo |
| --- | --- | --- |
| Imagen | JPEG, PNG | 5 MiB |
| Sticker | WebP | 500 KiB |
| Audio | AAC, MP4/M4A, MPEG/MP3, AMR, OGG/Opus | 16 MiB |
| Video | MP4, 3GPP | 16 MiB |
| Documento | PDF | 16 MiB |

Se comprueban tamaño, MIME, extensión y firmas del contenido; MP4 requiere la estructura y pista correspondiente. HTML, SVG, ejecutables y archivos Office no están habilitados para envío. El formulario recibe bytes y calcula su huella en el servidor: no acepta un `mediaId` ni una URL arbitrarios del navegador.

El DTO expone únicamente `/api/atencion/{id}/messages/{messageId}/media`, autenticada y sin caché pública. El servidor obtiene una URL temporal de Meta, valida su host/ruta y no sigue redirecciones. Los identificadores de descarga, tokens y URLs firmadas no se entregan al cliente. El soporte de rango para reproducción sigue sujeto al límite total del archivo.

En recepción y ecos de WhatsApp Business se admite también XLSX hasta 16 MiB,
conservando su nombre, caption e identificador original. Se verifica la estructura
ZIP de forma acotada, sin descomprimir, interpretar ni mostrar hojas de cálculo
en el servidor. La descarga es privada, forzada como adjunto y con `nosniff`.
Esto no amplía los formatos habilitados para envío. Otros documentos recibidos
mantienen su texto y un aviso de formato no compatible, en lugar de desaparecer
del historial. Un evento descartado y confirmado antes de esta corrección solo
puede recuperarse desde el original o una fuente histórica verificada; no se
reconstruyen identificadores, archivos o fechas a partir de capturas.

La lectura MCP histórica de Dapta conserva texto parcial y no recupera imágenes, audios o videos anteriores. Un chat nativo se vincula a un chat WhatsApp existente solo cuando su teléfono normalizado coincide exactamente y el resultado es único; conserva `externalId`, responsable y notas. Ante ambigüedad se crea un chat nativo sin responsable, sin elegir una identidad o sede arbitrarias. No se duplican clientes financieros.

Tras iniciar captura nativa, Dapta puede rellenar inbound anterior al primer mensaje Meta y conserva outbound de IA para mantener contexto durante la transición. Sus UUID no se convierten en `wamid`, y no se deduplican respuestas por semejanza de texto o fecha.

### Perfiles de WhatsApp e identificadores BSUID

La recepción nativa admite el formato BSUID ordinario documentado por Meta:
`messages[].from_user_id`, `message_echoes[].to_user_id` y
`statuses[].recipient_user_id`. Los teléfonos `from`, `to`, `recipient_id` y
`contacts[].wa_id` pueden omitirse en esos eventos. La firma, cuenta y línea
siguen verificándose antes de procesar el contenido. Véase el
[contrato oficial de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/?locale=en_US).

El BSUID se conserva completo como identidad del canal; nunca se extraen sus
dígitos para fabricar un teléfono. `profile.username` es una etiqueta mutable
para mostrar y buscar el contacto. No sirve para vincular conversaciones,
créditos, clientes o destinatarios. La relación teléfono–BSUID se aprende solo
cuando el mismo evento Meta acredita ambos y sus datos de contacto son
coherentes. Una colisión con dos conversaciones diferentes exige revisar el
vínculo; no se fusionan historiales por nombre. Los UUID históricos de Dapta no
acreditan por sí mismos esa relación.

El envío humano conserva el destinatario reservado en el outbox: usa `to` para
un teléfono acreditado y `recipient` para un BSUID sin teléfono. El acuse exige
`input` y `wa_id` o `user_id`, según el identificador utilizado. No se repite el
POST usando otra identidad ante un error. Se mantienen la ventana de respuesta,
los límites de archivos y el control de la IA. Las operaciones financieras y
las plantillas que requieren teléfono conservan su verificación actual; un
perfil sin teléfono acreditado no identifica automáticamente un crédito.

Los eventos ignorados dejan únicamente contadores de procesamiento en el log,
sin nombres, mensajes, teléfonos, BSUID, credenciales ni firmas. Los mensajes
que el receptor anterior descartó y confirmó no quedan guardados en el CRM ni
pueden reconstruirse desde una captura; la comprobación de recepción requiere
un mensaje nuevo del contacto o una fuente histórica verificable.

## Validación local

El tablero añade pruebas PostgreSQL/PGlite de permisos, búsqueda y paginación, conflictos de versión, idempotencia, archivo seguro, instalación repetible y conservación de un envío humano reservado. Las rutas se verifican con autenticación, origen y payloads inválidos; el instalador comprueba la nueva tabla, columnas, índice y eventos. Esta evidencia local no acredita que las nuevas columnas estén instaladas en producción ni que se haya ejecutado el cierre conjunto allí.

La ampliación de plantillas de cartera del 30 de octubre pasó las 342 pruebas de Atención, las 11 pruebas del adaptador de automatizaciones y la compilación de producción. Se comprobaron visualmente selección de crédito, bloqueo por crédito pagado o ausente, confirmación y desplazamiento en escritorio y en 390 × 667. Los envíos de esas pruebas usaron proveedores simulados y datos ficticios; no se enviaron mensajes financieros reales a clientes.

Las suites `atencion-meta`, `atencion-meta-storage`, `atencion-meta-service`, `atencion-templates`, `atencion-core`, `atencion-http`, `atencion-storage`, `atencion-schema-installer` y `railway-predeploy-packaging`, junto con las pruebas de interfaz y realtime, cubren proveedores simulados, persistencia PostgreSQL/PGlite, permisos, carreras, cancelación, lecturas, agenda, plantillas, adjuntos y empaquetado. Sus resultados no sustituyen la validación de la aplicación Meta, el webhook firmado real, el envío manual de una plantilla ni el control de Diana en producción.
