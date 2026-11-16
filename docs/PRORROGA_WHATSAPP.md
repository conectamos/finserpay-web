# WhatsApp al activar una prórroga

La automatización se integra a la activación existente de prórrogas por crédito.
No añade una pantalla de gestión ni cambia permisos de aprobación, pagos,
bloqueos, desbloqueos o reglas de nuevas solicitudes.

## Activación e historial

El trigger `CreditMoraExceptionRequest_whatsapp_activation` guarda la intención
de notificación en `CreditMoraExceptionRequest.activationWhatsApp` dentro de la
misma transacción que confirma la prórroga. Cubre el alta directa aprobada y el
paso de pendiente a aprobada con un autorizador humano. Rechazar, cancelar,
observar o fallar la transacción no inicia un envío. Las activaciones de Diana
con identidad de sistema conservan su comportamiento actual.

La instalación es aditiva y no rellena autorizaciones históricas. Una edición
de la solicitud tampoco crea otra notificación. La intención conserva crédito,
nombre, teléfono, responsable, activación, días y vencimiento aprobado. Los
eventos de decisión existentes permanecen inmutables; los intentos de WhatsApp
no incrementan la versión de la decisión.

Los días se calculan como la diferencia entre el día de activación en
`America/Bogota` y `expiresOn`, con mínimo de un día cuando activación y
vencimiento corresponden al mismo día. Por ejemplo, activación el 16 y
vencimiento el 20 producen **4 días**; activación y vencimiento el 16 producen
**1 día**. El vencimiento con hora es el final del día aprobado en Colombia.
No se calcula desde la fecha contractual de la cuota ni desde cada reintento.

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

La plantilla es `prorroga_activada`, idioma `es`, categoría `UTILITY`, sin
cabecera, pie ni botones. Usa parámetros posicionales `{{1}}` para el nombre y
`{{2}}` para los días. El único texto canónico se exporta como
`PRORROGA_ACTIVADA_TEMPLATE_BODY` desde
`lib/whatsapp-automation-meta-config.ts`; tanto el preparador como el adaptador
de envío lo comprueban sin mantener copias independientes.

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

Se aprobaron 216 pruebas en grupos de regresión independientes: activación,
Atención, aprobación/edición/cancelación, permisos, historial, worker,
transporte compartido, plantilla y cron. TypeScript, ESLint y `git diff --check`
terminaron sin errores. El build de producción con Turbopack terminó
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
| `tests/mora-extension-whatsapp-*.test.mjs` | Activación, envío, recuperación, permisos y preparación de plantilla |
| `tests/atencion-financial.test.mjs`, `tests/internal-cron-schedule.test.mjs`, `tests/mora-exception-api.test.mjs`, `tests/mora-exception-amendment-ui.test.mjs`, `tests/whatsapp-automation-meta.test.mjs` | Regresiones del flujo, cron y transporte existentes |
