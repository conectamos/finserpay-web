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

El flow de llamada recibe nombre completo y cédula del snapshot revalidado de FINSERPAY. Sofía los lee para que el cliente los confirme y, solo después de su aceptación clara, envía esos valores exactos a la herramienta. El flow de identidad admite tanto parámetros directos como el sobre `body.args` observado en una llamada real, y rechaza formatos ambiguos.

`POST /api/integraciones/dapta/bienvenida-voz/identidad` recibe JSON con el token firmado y el nombre completo/cédula confirmados. Solo devuelve condiciones cuando ambos coinciden con el crédito. La normalización conserva ceros iniciales, permite separadores y acentos, y rechaza nombres parciales. Máximo tres intentos. El evento y crédito quedan incluidos en el token, con vigencia máxima de 24 horas. El guion prohíbe leer importes o fechas si la herramienta devuelve un error, un enlace a `response.json` o cualquier resultado sin `ok=true`, `verificado=true` y un objeto `condiciones`.

El endpoint devuelve `{ok:true,verificado:true,condiciones:{...}}` o `{ok:true,verificado:false}`. Las condiciones contienen inicial, cuota comercial, cantidad de cuotas, frecuencia y calendario real del plan definitivo. Sin verificación no devuelve importes, documento ni celular.

## Resultado posterior

Configurar el `dapta_webhook` del nuevo agente como `https://finserpay.com/api/integraciones/dapta/bienvenida-voz/resultado`. El callback conserva `dynamic_variables.event_id`, `credito_id` y `event_token`, `agent_id`, `call_id`, estado, duración y análisis. En la llamada controlada se observó `dynamic_variables` como objeto, `credito_id` como string y el `agent_id` original con formato `agent_UUID`, mientras el registro resumido de Dapta lo muestra como UUID. El receptor acepta únicamente el UUID configurado en `DAPTA_WELCOME_VOICE_AGENT_ID` o ese mismo UUID con el prefijo literal `agent_`; cualquier otro agente sigue rechazado. Esta correspondencia evita el rechazo del callback real sin ampliar su alcance de evento o crédito. Los enlaces privados observados en `recording_url` y `public_log_url` utilizan HTTPS de `app.dapta.ai`.

El receptor valida token, evento, crédito y agente, deduplica `call_id` y rechaza asociaciones entre créditos distintos. El indicador de identidad proviene del backend, nunca del análisis del modelo. Solo guarda enlaces HTTPS de `app.dapta.ai`; no convierte grabaciones privadas en públicas. El expediente muestra resumen, dudas/diferencias, estado, fecha, duración y enlace. Su GET requiere sesión y alcance sobre el crédito, sin exponer token, snapshot ni transcripción.

## Comprobación antes de activar llamadas a clientes

1. Publicar el código con la función apagada; el predeploy crea el ledger.
2. Crear y verificar el agente y ambos flows con la confirmación exigida por Dapta.
3. Guardar configuración privada en Railway manteniendo el worker apagado hasta la prueba.
4. Realizar una llamada controlada autorizada con un crédito de prueba: comprobar voz/caller, aviso de grabación, identidad inválida sin condiciones e identidad correcta con datos reales.
5. Confirmar callback, vínculo al crédito, privacidad del log y botón de descarga manual de audio. Revisar que volver a enviar el mismo callback no duplique registros.
6. Activar `DAPTA_WELCOME_VOICE_ENABLED=true` para nuevos créditos. Vigilar estados por confirmar/fallidos sin reintentos automáticos.

### Ejecutar únicamente la prueba dirigida

Desde el checkout completo, con dependencias de desarrollo instaladas y las variables privadas ya disponibles en un entorno autorizado, mantener explícitamente `DAPTA_WELCOME_VOICE_ENABLED=false` y ejecutar:

```sh
node scripts/test-credit-welcome-voice.mjs --credit-id ID_CREDITO_PRUEBA --expected-phone +57CELULAR_REGISTRADO --test-phone +57NUMERO_PERSONAL_AUTORIZADO
```

Este comando solicita una llamada real, únicamente al número personal autorizado indicado explícitamente en `--test-phone`. `--expected-phone` debe coincidir con el celular registrado del crédito y funciona solo como guardia; nunca se usa como destino de esta prueba. Los dos números pueden ser diferentes. El helper no cambia el contacto del crédito ni el snapshot guardado: después de revalidar esos datos, reemplaza únicamente el destino en una copia temporal del snapshot que recibe el dispatcher. La identidad se verifica contra el nombre y documento reales del crédito seleccionado, y el resultado queda vinculado a ese crédito.

La fábrica habilitada existe solo en ese proceso y no modifica el interruptor del servicio. El helper inserta o reutiliza el evento `PENDING` de ese crédito y lo reclama por su identificador, con origen auditado `CONTROLLED_TEST`; conserva pendientes los eventos de otros créditos. Revalida contacto, condiciones y saldo antes de la solicitud a Dapta. Un evento ya intentado (`DISPATCHING`, `ACCEPTED`, `UNKNOWN` o cualquier estado cerrado) impide otra llamada. La ausencia o invalidez de `--test-phone` detiene el comando, sin reemplazarlo por el número del cliente.

La salida contiene solo `eventId`, `creditId` y `status`; no muestra número, URL privada, token ni condiciones. `ACCEPTED` significa que Dapta devolvió el identificador de llamada, no que la persona contestó. `UNKNOWN` exige conciliar el registro de Dapta y el callback; volver a ejecutar el comando no redespacha ese evento. El evento de prueba usa la misma unicidad por crédito que la llamada normal, por lo que habilitar posteriormente la función no vuelve a llamar a ese crédito.

La importación automática del archivo de audio permanece pendiente del contrato de descarga privada de Dapta. No se garantiza audio para llamadas no conectadas ni retención indefinida.

## Referencias

[Registro y descarga de llamadas](https://changelog.dapta.ai/), [nodo Dapta Phone Call](https://docs.dapta.ai/flow-studio/nodes/dapta-phone-call), [variables dinámicas](https://docs.dapta.ai/ai-voice-agents/how-to-set-up-your-ai-voice-agent/using-dynamic-variables), [webhook](https://docs.dapta.ai/integrations/webhook-set-up).
