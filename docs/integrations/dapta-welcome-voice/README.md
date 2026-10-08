# Bienvenida por voz al crear un crédito

Al confirmar un crédito definitivo se encola una llamada de bienvenida. El evento se guarda dentro de la misma transacción del crédito; el worker la solicita después del commit. FINSER PAY guarda estado, resultado, verificación de identidad y enlace privado de Dapta. El usuario descarga el audio desde el registro de llamadas de Dapta mientras se habilita su importación autenticada.

## Alcance

- Creación normal y formulario individual de créditos masivos con `welcomeOnCreate=true` y una sola fila.
- Los reintentos del formulario recuperan su recibo sin encolar otra llamada. Las importaciones históricas no generan llamadas.
- La cola revisa créditos cada 30 segundos y al iniciar el servicio. Antes de llamar revalida estado, pagos, identidad, celular y condiciones definitivas.
- Una llamada por crédito. Un timeout o respuesta ambigua queda por confirmar y requiere conciliación; no se redespacha a ciegas.
- La bienvenida de WhatsApp y el registro de llamada de aprobación conservan sus propios procesos.

## Configuración del servicio

| Variable | Uso |
| --- | --- |
| `DAPTA_WELCOME_VOICE_ENABLED` | `true` habilita el encolado y worker; ausente/otro valor mantiene la función apagada. |
| `DAPTA_WELCOME_VOICE_WEBHOOK_URL` | Webhook privado HTTPS del flow de llamada, host `api.dapta.ai`. |
| `DAPTA_WELCOME_VOICE_TOKEN_SECRET` | Secreto aleatorio de al menos 32 caracteres, solo en FINSER PAY. |
| `DAPTA_WELCOME_VOICE_AGENT_ID` | UUID del nuevo agente de bienvenida; también limita los callbacks aceptados. |

No guardar URLs privadas, tokens ni credenciales en Git. Las plantillas JSON son borradores y requieren los identificadores reales antes de activar. Crear un agente separado llamado `FINSERPAY — Bienvenida`, identidad Sofía, español Colombia/Latinoamérica `es-419`, propósito atención al cliente `101`. Usar `agent-instructions.txt`; habilitar detección de buzón con colgado, log privado y grabación. Aplicar apertura mediante la actualización de agente: Dapta descarta `begin_message` al crear.

## Verificación durante la llamada

La herramienta `verificar_cliente_bienvenida` ejecuta el flow de identidad. Sus parámetros individuales son strings: `dapta_api_id`, `dapta_webhook`, `event_token`, `customer_name`, `customer_document`. Los primeros dos tienen constantes del flow; el token se pasa exacto desde la variable de llamada mediante la descripción, nunca mediante un `const` con mustaches. Dapta resuelve su callback interno; no proporcionar `tool.url`.

`POST /api/integraciones/dapta/bienvenida-voz/identidad` recibe JSON con el token firmado y nombre completo/cédula expresados por la persona. Solo devuelve condiciones cuando ambos coinciden. La normalización conserva ceros iniciales, permite separadores y acentos, y rechaza nombres parciales. Máximo tres intentos. El evento y crédito quedan incluidos en el token, con vigencia máxima de 24 horas.

El endpoint devuelve `{ok:true,verificado:true,condiciones:{...}}` o `{ok:true,verificado:false}`. Las condiciones contienen inicial, cuota comercial, cantidad de cuotas, frecuencia y calendario real del plan definitivo. Sin verificación no devuelve importes, documento ni celular.

## Resultado posterior

Configurar el `dapta_webhook` del nuevo agente como `https://finserpay.com/api/integraciones/dapta/bienvenida-voz/resultado`. El callback conserva `dynamic_variables.event_id`, `credito_id` y `event_token`, `agent_id`, `call_id`, estado, duración y análisis. Estos nombres siguen el callback observado del workspace, que debe corroborarse en una llamada controlada.

El receptor valida token, evento, crédito y agente, deduplica `call_id` y rechaza asociaciones entre créditos distintos. El indicador de identidad proviene del backend, nunca del análisis del modelo. Solo guarda enlaces HTTPS de `app.dapta.ai`; no convierte grabaciones privadas en públicas. El expediente muestra resumen, dudas/diferencias, estado, fecha, duración y enlace. Su GET requiere sesión y alcance sobre el crédito, sin exponer token, snapshot ni transcripción.

## Comprobación antes de activar llamadas a clientes

1. Publicar el código con la función apagada; el predeploy crea el ledger.
2. Crear y verificar el agente y ambos flows con la confirmación exigida por Dapta.
3. Guardar configuración privada en Railway manteniendo el worker apagado hasta la prueba.
4. Realizar una llamada controlada autorizada con un crédito de prueba: comprobar voz/caller, aviso de grabación, identidad inválida sin condiciones e identidad correcta con datos reales.
5. Confirmar callback, vínculo al crédito, privacidad del log y botón de descarga manual de audio. Revisar que volver a enviar el mismo callback no duplique registros.
6. Activar `DAPTA_WELCOME_VOICE_ENABLED=true` para nuevos créditos. Vigilar estados por confirmar/fallidos sin reintentos automáticos.

La importación automática del archivo de audio permanece pendiente del contrato de descarga privada de Dapta. No se garantiza audio para llamadas no conectadas ni retención indefinida.

## Referencias

[Registro y descarga de llamadas](https://changelog.dapta.ai/), [nodo Dapta Phone Call](https://docs.dapta.ai/flow-studio/nodes/dapta-phone-call), [variables dinámicas](https://docs.dapta.ai/ai-voice-agents/how-to-set-up-your-ai-voice-agent/using-dynamic-variables), [webhook](https://docs.dapta.ai/integrations/webhook-set-up).
