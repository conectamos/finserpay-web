# Atención: operación del canal directo de Meta

Revisión: 30 de octubre de 2026. El código y las diez tablas de Atención están desplegados. La aplicación Meta `1128613623424831` está publicada, con credenciales dedicadas configuradas en Railway, callback verificado y suscripción a mensajes confirmada. Se comprobó la recepción real de texto, imagen, audio y video en el CRM, conservando el chat existente y su analista; los medios de prueba cargaron y se reprodujeron mediante rutas privadas. El envío y la confirmación de control de la IA siguen desactivados; Dapta conserva su suscripción y no se ha realizado el corte. Las lecturas MCP ya confirmadas no equivalen a una API productiva verificada de Dapta como motor de respuestas del CRM.

## Estado operativo confirmado al 30 de octubre de 2026

- **Aplicación y acceso:** Atención `1128613623424831`, publicada en el negocio Finser PAY `1109745271496382`. Usuario de sistema `61595750474386`, tipo Employee, con acceso Desarrollar a la aplicación y acceso Todo a la cuenta de mensajería vinculada `2148284059050848`, autorizados por el propietario.
- **Credenciales:** token permanente con `whatsapp_business_messaging` y `whatsapp_business_management` guardado en Railway. `WHATSAPP_ATTENTION_ACCESS_TOKEN`, `WHATSAPP_ATTENTION_APP_SECRET` y `WHATSAPP_ATTENTION_VERIFY_TOKEN` están configuradas. Los IDs estrictos del número y de la cuenta de mensajería se conservaron; no se documentan valores secretos.
- **Identidad comprobada:** las lecturas Graph v26 confirmaron Phone Number ID `1162059967000416`, número `+573124085562` y nombre verificado Finser PAY. La cuenta de mensajería `2148284059050848` devolvió únicamente ese número. La interfaz distingue la cuenta WhatsApp `1647162566997935` de su cuenta de mensajería vinculada `2148284059050848`; no deben intercambiarse esos IDs.
- **Webhook y suscripciones:** Meta verificó `https://finserpay.com/api/integraciones/atencion/whatsapp` y quedó suscrito el campo `messages` en v26. La lectura de `subscribed_apps` mostró inicialmente Dapta `1109377124599528` y después Atención `1128613623424831` junto con Dapta, cuya suscripción se preservó.
- **Enrutamiento:** la consulta `routing_roles` respondió HTTP 400, código 100, «Conversation routing is not enabled». No se habilitó ni se incorporó al contrato del CRM. La [documentación oficial de Conversation Routing de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/thread-control) queda como referencia de una alternativa, sin acreditar disponibilidad para esta línea ni control de la IA.
- **Despliegues:** código y esquema de diez tablas en commit `fba3f60c69fe880e11c87696edc311e9e9ee538a`; actualización de privacidad en `34060e6e`. El último despliegue Railway comprobado, `c87ff0eb-233f-4d09-a812-0fec0f1d5f05`, figura como SUCCESS.
- **Pendiente:** validar respuesta saliente, traspaso/control de la IA e histórico Dapta. `WHATSAPP_ATTENTION_SEND_ENABLED=false` y `WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED=false` se mantienen hasta verificar el control de la IA. La integración de Dapta exclusivamente como motor de IA no está terminada; la prueba de recepción no acredita esas capacidades.

## Prueba operativa de recepción y medios

El 30 de octubre de 2026, un mensaje de prueba enviado por el propietario llegó al chat existente y conservó su asignación al analista. El diagnóstico productivo `GET /api/atencion/integration`, con sesión administrativa, devolvió `configured=true`, `webhookReady=true`, `missing=[]` y coincidencia exacta con la línea principal autorizada. `canSend=false` y ambos indicadores de envío/control de IA permanecieron en `false`.

En el despliegue Railway `c87ff0eb-233f-4d09-a812-0fec0f1d5f05` se observaron POST del webhook con HTTP 200 desde `2026-10-30T16:30:36Z`. A las 11:33 de Bogotá se enviaron imagen, audio y video de prueba, con estos resultados en los elementos nativos del navegador:

| Medio | Resultado comprobado |
| --- | --- |
| Imagen | Imagen de 1080 px cargada; `complete=true` |
| Audio | Reproducción hasta completar 3,7465 segundos; `readyState=4`, `error=null` |
| Video | Reproducción hasta completar 2,6 segundos, resolución 576 × 1024; `readyState=4`, `error=null` |

Los medios se obtuvieron por `/api/atencion/{id}/messages/{messageId}/media`. Esta evidencia corresponde a los archivos de prueba recibidos; no incluye teléfonos personales, identificadores de clientes ni contenido de los medios. No acredita envío saliente, traspaso de IA o recuperación retroactiva de adjuntos del histórico Dapta, que siguen fuera de esta comprobación.

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

## Webhook y activación gradual

La ruta implementada es `GET/POST /api/integraciones/atencion/whatsapp`. En el dominio principal, el callback es:

```text
https://finserpay.com/api/integraciones/atencion/whatsapp
```

Debe apuntar directamente al despliegue HTTPS correcto. El GET responde al desafío `hub.mode=subscribe`, valida el verify token y rechaza parámetros repetidos. El POST verifica `X-Hub-Signature-256` con HMAC SHA-256 sobre los bytes originales antes de interpretar JSON, limita el cuerpo a 1 MiB y procesa únicamente `object=whatsapp_business_account`, campo `messages`, WABA y Phone Number ID autorizados. Un error de persistencia no recibe un éxito ficticio.

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

El Dockerfile incluye expresamente los tres archivos de esa cadena en el runner y copia las dependencias PostgreSQL necesarias. El arranque es `node server.js`. El instalador toma un advisory lock, valida la estructura previa, ejecuta SQL transaccional en `public` y verifica diez tablas, columnas, claves y auditoría inmutable. El comando manual equivalente es `npm run db:setup-atencion`, con `DATABASE_URL` solo en el entorno del servidor. No se ejecuta DDL desde solicitudes web.

La actualización conserva las siete tablas anteriores y añade `AttentionMetaBinding`, `AttentionMetaOutbox` y `AttentionMetaDelivery`, junto con campos Meta en conversaciones/mensajes. `AttentionAudit` admite un usuario real o el actor de sistema explícito `SYSTEM_META`; su trigger sigue impidiendo UPDATE y DELETE. La identidad Meta `(phoneNumberId, wamid)` y la identidad externa de Dapta se almacenan por separado. El esquema financiero no cambia.

Los datos durables residen en PostgreSQL, no en el sistema de archivos del contenedor. Reiniciar/reemplazar el runner no elimina conversaciones u outbox si se conserva la misma base. La base guarda referencias de medios y metadatos; los bytes se descargan de Meta bajo autorización cuando se solicitan. No hay un archivo permanente de adjuntos ni garantía de conservación indefinida del proveedor. No se necesita un volumen Docker para esta implementación. Las tablas se administran por este SQL, sin agregarlas a Prisma ni sustituir su instalación por `prisma db push`.

Si aún existe el esquema anterior de siete tablas, el detalle conserva la lectura histórica y la capacidad Meta permanece deshabilitada. Un rollback de aplicación debe conservar un instalador compatible con el esquema ampliado; no se deben borrar tablas o mensajes para adaptar la base a un binario anterior.

## Respuesta humana y recuperación

Administración central supervisa la bandeja global. Los analistas nominales activos solo pueden leer/responder en conversaciones asignadas a su identidad; las cuentas de vendedor, supervisor, aliado o enlaces compartidos no reciben acceso. El servidor revalida el rol y la asignación en la transacción y antes del POST. Para descargar medios vuelve a comprobar el acceso después de la lectura de red.

Cada respuesta exige una ventana abierta de 24 horas desde el último inbound nativo validado. El histórico Dapta no abre esa ventana. Esta versión no implementa envío de plantillas fuera de ventana. El texto admite hasta 4096 caracteres; las descripciones de imagen, video o PDF admiten hasta 1024. Audio y sticker no admiten descripción en este flujo.

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

## Archivos e histórico

Estos son los formatos y límites de esta aplicación; pueden ser más restrictivos que los admitidos por Meta:

| Tipo | Formatos admitidos | Máximo |
| --- | --- | --- |
| Imagen | JPEG, PNG | 5 MiB |
| Sticker | WebP | 500 KiB |
| Audio | AAC, MP4/M4A, MPEG/MP3, AMR, OGG/Opus | 16 MiB |
| Video | MP4, 3GPP | 16 MiB |
| Documento | PDF | 16 MiB |

Se comprueban tamaño, MIME, extensión y firmas del contenido; MP4 requiere la estructura y pista correspondiente. HTML, SVG, ejecutables y archivos Office no están habilitados. El formulario recibe bytes y calcula su huella en el servidor: no acepta un `mediaId` ni una URL arbitrarios del navegador.

El DTO expone únicamente `/api/atencion/{id}/messages/{messageId}/media`, autenticada y sin caché pública. El servidor obtiene una URL temporal de Meta, valida su host/ruta y no sigue redirecciones. Los identificadores de descarga, tokens y URLs firmadas no se entregan al cliente. El soporte de rango para reproducción sigue sujeto al límite total del archivo.

La lectura MCP histórica de Dapta conserva texto parcial y no recupera imágenes, audios o videos anteriores. Un chat nativo se vincula a un chat WhatsApp existente solo cuando su teléfono normalizado coincide exactamente y el resultado es único; conserva `externalId`, responsable y notas. Ante ambigüedad se crea un chat nativo sin responsable, sin elegir una identidad o sede arbitrarias. No se duplican clientes financieros.

Tras iniciar captura nativa, Dapta puede rellenar inbound anterior al primer mensaje Meta y conserva outbound de IA para mantener contexto durante la transición. Sus UUID no se convierten en `wamid`, y no se deduplican respuestas por semejanza de texto o fecha. El webhook nativo todavía no soporta BSUID opacos: solo procesa remitentes y destinatarios telefónicos válidos. Un ID opaco no se convierte en teléfono; ese caso requiere ampliar el contrato antes de prometer cobertura completa.

## Validación local

Las suites `atencion-meta`, `atencion-meta-storage`, `atencion-meta-service`, `atencion-schema-installer` y `railway-predeploy-packaging` verifican proveedores simulados, persistencia PostgreSQL/PGlite, permisos, carreras, cancelación, adjuntos y empaquetado. Sus resultados no sustituyen la validación de la aplicación Meta, el webhook firmado real ni el control de Diana en producción.
