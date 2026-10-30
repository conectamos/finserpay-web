# Automatizaciones de WhatsApp por Meta

Las campañas existentes pueden usar directamente la línea principal de FINSER PAY
en Meta mientras las respuestas de Diana permanecen pausadas en Dapta. Este cambio
no activa llamadas, no cambia el número y no elimina la integración de Dapta.

## Selección del transporte

`WHATSAPP_AUTOMATIONS_PROVIDER=meta` selecciona Meta explícitamente. Ausente, vacío
o `dapta` conserva el transporte anterior. Cualquier otro valor impide el envío.
El proveedor y su configuración se capturan antes de reservar cada corrida; un
error de Meta jamás provoca un segundo intento por Dapta.

Meta utiliza exclusivamente las credenciales privadas de Atención:
`WHATSAPP_ATTENTION_ACCESS_TOKEN`, `WHATSAPP_ATTENTION_PHONE_NUMBER_ID`,
`WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID` y `WHATSAPP_GRAPH_API_VERSION`. También
deben estar habilitados los controles de envío y coordinación del canal
`WHATSAPP_ATTENTION_SEND_ENABLED` y `WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED`.
No se reutilizan las credenciales del número de OTP. El adaptador verifica la
línea, la cuenta y las plantillas aprobadas antes del envío.

Se conservan los habilitadores de cada campaña, aunque sus nombres históricos
comiencen por `DAPTA_`. Al seleccionar Meta no se exige el webhook de Dapta.
`1_dia_falta` y `hoyvence` usan nombre en la posición 1 y `FINSER PAY` en la
posición 2, según el orden de las plantillas aprobadas. Las otras plantillas con
nombre usan únicamente la posición 1.

| Campaña | Habilitador | Plantilla / idioma | Activación existente |
| --- | --- | --- | --- |
| Bienvenida | `DAPTA_BIENVENIDA_ENABLED` | `bienvenida` / `es` | Creación individual nueva de crédito |
| Vence mañana | `DAPTA_RECORDATORIO_1_DIA_ENABLED` | `1_dia_falta` / `es` | 10:00–10:59 Bogotá |
| Vence hoy | `DAPTA_HOYVENCE_ENABLED` | `hoyvence` / `es` | 10:00–10:59 Bogotá |
| Faltan dos días | `DAPTA_RECORDATORIO_2_DIAS_ENABLED` | `2dias` / `es` | 13:00–13:59 Bogotá |
| Datos | `DAPTA_DATOS_ENABLED` | `data` / `es` | Día exacto 20 de mora, 10:00–10:59 Bogotá |
| Cuota vencida | `DAPTA_CUOTAVENCIDA_ENABLED` | `cuotavencida` / `es_AR` | Lote manual existente, procesado por el worker |
| Bloqueo | `DAPTA_BLOQUEO_ENABLED` | `bloqueo` / `es` | Lote manual existente, procesado por el worker |

Las cabeceras con imagen requieren los archivos originales estables en:

- `WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL`
- `WHATSAPP_AUTOMATIONS_CUOTAVENCIDA_HEADER_IMAGE_URL`
- `WHATSAPP_AUTOMATIONS_BLOQUEO_HEADER_IMAGE_URL`

Solo se admiten los orígenes de archivos previamente verificados por el adaptador.
Las URLs de muestra temporales de Meta no son una configuración de producción.
Los tres originales PNG se recuperaron desde la vista de las plantillas aprobadas
del Administrador de WhatsApp el 30 de octubre de 2026 y se verificaron visualmente:
`public/whatsapp/templates/2dias.png` (plantilla 1434166731999987),
`cuotavencida.png` (1443541817715270) y `bloqueo.png` (1591101429727994).
Las URLs estables son `https://finserpay.com/whatsapp/templates/<nombre>.png`.
No contienen datos de clientes ni se alteró el contenido de las imágenes.
`bloqueo` no lleva parámetros de cuerpo; enviar esa plantilla no ejecuta ningún
comando de bloqueo de dispositivos.

## Continuidad y prevención de duplicados

Los registros `CreditDueReminder`, `CreditOverdueDataAttempt` y su cobertura,
`CuotaVencidaWhatsAppEvent` y `BloqueoWhatsAppEvent` conservan sus claves y reglas.
No se borran ni se reinician resultados `ACCEPTED`, `FAILED` o `UNKNOWN` al cambiar
el transporte. En particular, un intento ambiguo previo por Dapta no se vuelve a
enviar por Meta. La bienvenida nativa usa una operación única por crédito; no se
recorre la cartera histórica para recuperar bienvenidas.

El outbox nativo registra el intento antes del HTTP. La aceptación requiere un
identificador real de Meta; no significa entrega ni lectura. El webhook firmado
concilia los estados posteriores y los mensajes enviados aparecen en Atención
con autor de automatización. Un fallo de red queda pendiente de conciliación,
sin reintento automático ni cambio de proveedor.

Se revalidan crédito, destinatario, vencimiento, prórrogas y vigencia de la reserva
después de la preparación de Meta. Tanto los recordatorios programados y Datos
como los envíos manuales y de cartera mantienen los locks financieros desde la
última revisión hasta el POST final. Datos bloquea y revisa todos los créditos ya
cubiertos por el intento; no incorpora otros créditos durante el envío. Las
transacciones del outbox y del CRM ocurren fuera de esos locks para evitar
invertir su orden. Un rechazo en esta última revisión conserva el intento sin
crear un reintento automático.

## Verificación operativa

Antes de activar, instalar el esquema nativo, confirmar las siete plantillas y
sus parámetros, verificar los tres archivos y revisar los estados existentes.
Las consultas GET de diagnóstico y los previews permanecen sin envío. La
activación respeta la próxima ventana normal; no crea lotes ni recuperación
automática fuera de horario.

No cambiar `FINSERPAY_INTERNAL_CRON` para habilitar solo WhatsApp: ese control
también gobierna otros trabajos. Tampoco cambiar `DAPTA_WELCOME_VOICE_*`,
`DAPTA_VOICE_REVIEW_CAMPAIGN_*` o `DAPTA_COBRANZA_*`; las llamadas y los mensajes
posteriores a llamadas (`medios` y `soporte`) permanecen fuera de este cambio.

Para detener una campaña, desactivar su habilitador. Si se revierte el proveedor,
se conservan todos los ledgers y el outbox: no borrar intentos para intentar
recuperar entregas inciertas.
