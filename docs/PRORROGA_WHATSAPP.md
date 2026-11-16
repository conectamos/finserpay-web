# WhatsApp al activar una prórroga

La automatización se integra a la activación existente de prórrogas por crédito.
No añade una pantalla de gestión ni cambia permisos de aprobación, pagos,
bloqueos, desbloqueos o reglas de nuevas solicitudes.

## Activación e historial

El trigger `CreditMoraExceptionRequest_whatsapp_activation` guarda la intención
de notificación en `CreditMoraExceptionRequest.activationWhatsApp` dentro de la
misma transacción que confirma la autorización. Cubre las solicitudes de tipo
`PRORROGA` y las autorizaciones temporales guardadas como `EXCEPCION` con
`expiresOn` definido, tanto en el alta directa aprobada como en el paso de
pendiente a aprobada con un autorizador humano. El formulario actual inicia
con el tipo `EXCEPCION`; una autorización con fecha recibe la misma notificación
sin reclasificarla ni cambiar sus condiciones. Las excepciones sin vencimiento
se conservan y no generan esta notificación. Rechazar, cancelar, observar o
fallar la transacción no inicia un envío. Las activaciones de Diana con
identidad de sistema conservan su comportamiento actual.

La instalación es aditiva y no rellena autorizaciones históricas. Una edición
de la solicitud tampoco crea otra notificación. La intención conserva crédito,
nombre, teléfono, responsable, activación, días y vencimiento aprobado. Los
eventos de decisión existentes permanecen inmutables; los intentos de WhatsApp
no incrementan la versión de la decisión.

Los nuevos avisos calculan los días como `expiresOn − installmentDueDate`, por
fechas calendario. Una cuota del **17** con prórroga hasta el **21** produce
**4 días**, independientemente de si se activa el 16, 18 o 20. La fecha base
se congela en el JSON de WhatsApp y se conserva al reintentar; no se usa el día
de activación ni el del reintento. El mensaje también muestra el vencimiento
como `DD/MM/AAAA`, y la hora efectiva sigue siendo el final del día aprobado
en `America/Bogota`.

Las solicitudes con cuota vinculada utilizan esa fecha. El alta central deja
sus columnas contractuales sin cuota por diseño: en su misma transacción se
consulta el helper existente `financialPlan()` y se guarda únicamente en el
JSON del aviso la primera cuota regular pendiente. Esto respeta abonos, cuotas
eliminadas y planes de capital, sin usar el override `fechaProximoPago`. No se
inventan fechas a partir del último 02/17 del calendario ni se reclasifica la
autorización. Si falta una cuota verificable o el plazo no es positivo, el
aviso queda fallido con explicación y la autorización conserva sus condiciones.

Una prórroga sin fecha queda fallida con explicación; no se inventa una
cantidad de días. El administrador puede corregir su fecha y usar
«Reintentar WhatsApp». Los datos faltantes del cliente también deben corregirse
en el crédito antes del reintento.

El detalle existente de la solicitud muestra activación, días, responsable,
vencimiento aprobado, intentos, estado y fecha del envío. «Enviado» significa
aceptación por WhatsApp con identificador real, no entrega o lectura. Estas
últimas se consultan en Atención mediante el webhook firmado existente.

## Procesamiento y reintentos

El worker se ejecuta desde el cron interno existente cada 30 segundos y al
iniciar el servidor. No depende de conservar una pestaña abierta. Reutiliza el
transporte Meta, su línea, credenciales privadas de Atención y el outbox
`WhatsAppAutomationMetaOutbox`; no usa el número de OTP ni cambia de proveedor
como alternativa ante un error.

La reserva en base de datos y la clave única por activación e intento evitan
duplicados entre procesos y reintentos de la activación. Antes del POST se
verifican nuevamente la vigencia de la prórroga y sus datos. Los fallos
definitivos anteriores al envío permiten reintentos automáticos; una entrega
fallida confirmada permite reintento manual desde el detalle autorizado.

Si hubo un timeout después de transmitir y el resultado es incierto, el estado
queda pendiente de conciliación. No se reenvía automáticamente ni se habilita
un reintento manual ciego. El webhook existente correlaciona el identificador
de Meta o `biz_opaque_callback_data` con el outbox antes de decidir el resultado.

## Plantilla de Meta

El 16 de noviembre de 2026 se revisó el workspace FINSERPAY de Dapta: los
flujos de Cuotavencida/Bloqueo envían plantillas con variables y recibo, mientras
que «FINSERPAY — Prórrogas de Diana» llama al backend para conceder prórrogas
automáticas y no corresponde a las activaciones humanas de este cambio.
También se verificó en Railway producción que
`WHATSAPP_AUTOMATIONS_PROVIDER=meta`. Se conserva ese selector y se reutiliza
el transporte activo; no se crea otro flujo ni se modifica la configuración
de Dapta.

La plantilla `prorroga_activada` se registró en la cuenta Finser PAY de Meta,
idioma `es`, categoría Servicio/UTILITY, con el cuerpo solicitado y ejemplos
ficticios. ID: `2558909317954460`. Al confirmar el registro figuraba en revisión;
la verificación final mostró **Activa: calidad pendiente**, con cero mensajes
enviados. El adaptador exige `APPROVED` antes de transmitir. Registrar la
plantilla no despliega este código ni instala el esquema en producción.

Los nuevos avisos usan `prorroga_activada_v2`, idioma `es`, categoría `UTILITY`,
sin cabecera, pie ni botones. Sus parámetros posicionales son `{{1}}` nombre,
`{{2}}` días desde la cuota y `{{3}}` fecha de vencimiento. El cuerpo canónico
`PRORROGA_ACTIVADA_V2_TEMPLATE_BODY` añade la línea
`📅 *Fecha de vencimiento de la prórroga:* {{3}}`.
Se registró en Meta el 16 de noviembre de 2026 con ID `1672395654266933`.

La plantilla aprobada anterior `prorroga_activada` se conserva exactamente con
sus dos parámetros. Los avisos históricos sin versión explícita siguen usando
esa versión para conservar sus recibos y operaciones inciertas, sin reenviar
mensajes ya aceptados. No se cambia la plantilla ni el cuerpo bajo una clave
de operación existente. El worker selecciona la versión guardada en cada
activación; el preparador consulta o registra únicamente la nueva v2. Ambos
cuerpos se exportan desde `lib/whatsapp-automation-meta-config.ts` y el emisor
comprueba el texto aprobado correspondiente antes del envío.

Meta debe aprobar la plantilla antes de utilizarla. El permiso de gestión de
plantillas es `whatsapp_business_management`; la creación utiliza ejemplos
ficticios. Consulte la [referencia oficial de plantillas de Meta](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/).

Con `WHATSAPP_ATTENTION_ACCESS_TOKEN` disponible en un entorno privado autorizado,
consultar la plantilla sin modificarla:

```powershell
node scripts/prepare-prorroga-whatsapp-template.mjs
```

Crear la plantilla solo si no existe, enviándola al proceso de aprobación de Meta:

```powershell
node scripts/prepare-prorroga-whatsapp-template.mjs --apply
```

El script usa Graph `v25.0` y la cuenta fija de la integración, nunca un WABA
arbitrario. Rechaza una configuración explícita de cuenta o línea distinta.
Una plantilla existente con contenido, idioma, categoría o estructura diferente
se informa como conflicto y no se sobrescribe. Una plantilla pendiente o
rechazada solo se consulta: `--apply` no la recrea ni modifica. El script no
envía mensajes, no activa campañas y no imprime tokens. Su código de salida es
0 para una plantilla aprobada y válida, 2 si falta o espera aprobación y 1 ante
un error de configuración, conflicto o API.

La automatización conserva los controles existentes de envío: proveedor `meta`,
`WHATSAPP_ATTENTION_SEND_ENABLED=true`,
`WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED=true`, versión `v25.0`, línea y WABA
coincidentes con la configuración compartida. No cambie
`FINSERPAY_INTERNAL_CRON` para habilitar solo esta notificación, porque también
controla otros procesos.

El acceso OAuth de Railway permite consultar los nombres de variables, pero no
el token. Por ello, el registro y su estado se verificaron desde la sesión
autorizada del Administrador de WhatsApp. El registro de la plantilla y las
pruebas locales no despliegan el código ni envían mensajes reales a clientes.

## Aviso de tres meses

El cuerpo conserva el aviso solicitado de tres meses por incumplimiento.
La revisión no encontró una regla automática equivalente para `PRORROGA`.
Existe un enfriamiento distinto de 20 días completos para determinadas
`EXCEPCION` incumplidas. Ambas reglas se conservan: este cambio no añade un
bloqueo automático de tres meses.

## Validación

La actualización de cuota y vencimiento aprobó 393 pruebas de la suite de
mora, además de las 36 pruebas de plantilla/emisor y las 29 de Atención
financiera (algunas pruebas de plantilla también forman parte de la suite de
mora). Cubren activación, aprobación/edición/cancelación, permisos, historial,
worker, transporte compartido y la convivencia de las versiones de plantilla.
TypeScript, ESLint y `git diff --check` terminaron sin errores.
El build de producción con Turbopack de esta actualización también terminó
correctamente; para las dependencias enlazadas de esta copia local se amplió
temporalmente `turbopack.root` al directorio común de los archivos. La
configuración original se restauró byte por byte después del build y no forma
parte del cambio. Las pruebas no activan créditos reales ni contactan clientes.

Las pruebas utilizan clientes sintéticos y proveedores simulados. Para comprobar
el preparador de Meta y la API/UI del historial:

```powershell
node --test tests/mora-extension-whatsapp-template.test.mjs tests/mora-extension-whatsapp-api.test.mjs tests/mora-exception-amendment-ui.test.mjs
```

La validación completa también debe ejecutar las pruebas de activación y worker,
las regresiones existentes de prórrogas y Meta, TypeScript y el build antes de
desplegar. La prueba operativa con una línea de ensayo requiere primero la
plantilla aprobada y las credenciales del entorno de envío.

## Archivos de la implementación

| Archivo | Cambio |
| --- | --- |
| `scripts/mora-exception-requests-schema.mjs` | Intención transaccional y trigger en la solicitud existente; sin backfill |
| `lib/mora-extension-whatsapp.ts` | Reserva, conciliación, envío protegido, consulta y reintento |
| `lib/internal-cron.ts` | Procesamiento cada 30 segundos y recuperación al iniciar |
| `lib/mora-exception-types.ts` | Datos del historial de WhatsApp |
| `app/api/aprobaciones/excepciones-mora/[id]/route.ts` | Consulta autorizada del estado en el detalle |
| `app/api/aprobaciones/excepciones-mora/[id]/whatsapp/route.ts` | Reintento autorizado con datos del servidor |
| `app/dashboard/aprobaciones/excepciones-mora/mora-exception-requests-client.tsx` | Historial y reintento en el panel actual |
| `lib/whatsapp-automation-meta-config.ts`, `lib/whatsapp-automation-meta.ts` | Plantilla y verificación del cuerpo exacto |
| `scripts/setup-whatsapp-automation-meta.sql`, `scripts/whatsapp-automation-meta-schema.mjs` | Ampliación aditiva del outbox compartido |
| `scripts/prepare-prorroga-whatsapp-template.mjs` | Consulta o alta de plantilla ausente; nunca envía mensajes |
| `package.json` | Incluye las pruebas de WhatsApp de prórrogas en `test:mora-analista`, ejecutado por CI |
| `tests/mora-extension-whatsapp-*.test.mjs` | Activación, envío, recuperación, permisos y preparación de plantilla |
| `tests/atencion-financial.test.mjs`, `tests/internal-cron-schedule.test.mjs`, `tests/mora-exception-api.test.mjs`, `tests/mora-exception-amendment-ui.test.mjs`, `tests/whatsapp-automation-meta.test.mjs` | Regresiones del flujo, cron y transporte existentes |
