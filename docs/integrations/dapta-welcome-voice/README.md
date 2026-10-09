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
| `DAPTA_WELCOME_VOICE_IDENTITY_FLOW_TOKEN` | Bearer privado distinto del secreto HMAC, compartido únicamente entre Railway y el encabezado HTTP del flow de identidad. |
| `DAPTA_WELCOME_VOICE_AGENT_ID` | UUID del nuevo agente de bienvenida; también limita los callbacks aceptados. |

No guardar URLs privadas, tokens ni credenciales en Git. Las plantillas JSON son borradores y requieren los identificadores reales antes de activar. Usar el agente separado `FINSERPAY — Bienvenida`, identidad Diana, español Colombia/Latinoamérica `es-419`, propósito atención al cliente `101`. La marca escrita conserva `FINSER PAY`; el guion la pronuncia «FINSER PEY» según la instrucción del usuario. Usar `agent-instructions.txt`; habilitar detección de buzón con colgado, log privado y grabación. Aplicar apertura mediante la actualización de agente: Dapta descarta `begin_message` al crear.

## Verificación durante la llamada

La herramienta `verificar_cliente_bienvenida` ejecuta el flow de identidad. Sus parámetros individuales son strings: `dapta_api_id`, `dapta_webhook`, `event_id`, `customer_name`, `customer_document`. Los primeros dos tienen constantes del flow; el identificador del evento se pasa exacto desde la variable de llamada mediante la descripción, nunca mediante un `const` con mustaches. El modelo no copia el token firmado en esta consulta. Dapta resuelve su callback interno; no proporcionar `tool.url`.

El trigger y el normalizador del flow de llamada conservan sus ocho campos de entrada por compatibilidad. El nodo nativo transmite únicamente `event_id`, `credito_id` y `event_token`: no entrega nombre, cédula ni versiones habladas al agente. El token firmado original permanece disponible para el callback, sin ser un parámetro de la herramienta de identidad. Diana pregunta primero el nombre completo y después la cédula; envía las respuestas reales, nunca una sustitución por los datos registrados. La cédula llega como una transcripción literal de hasta 240 caracteres, aceptando bloques hablados, dígitos o números sin exigir una modalidad ni ofrecer ejemplos. El backend la interpreta de forma determinista, conserva ceros y rechaza ambigüedades sin elegir un candidato por el documento esperado. El flow de identidad admite parámetros directos o el sobre `body.args`, selecciona únicamente los tres campos de identidad y rechaza formatos mixtos.

`POST /api/integraciones/dapta/bienvenida-voz/identidad` recibe JSON con `event_id`, nombre y cédula literal. El nodo `qryId` envía `Authorization: Bearer ...` con `DAPTA_WELCOME_VOICE_IDENTITY_FLOW_TOKEN`; el backend autentica el encabezado en tiempo constante y resuelve únicamente el snapshot de ese evento, con antigüedad máxima de 24 horas y estado `DISPATCHING`, `ACCEPTED` o `UNKNOWN`. Mantiene un máximo de tres intentos de identidad. El nombre debe conservar todos los componentes registrados exactamente y en su orden, con el mismo primer componente; admite componentes adicionales, sin comparación difusa ni omisiones de componentes registrados. El documento interpretado debe coincidir exactamente, incluidos los ceros.

El modo anterior del endpoint con `event_token` firmado permanece compatible, pero este nuevo flow no lo envía. El bearer privado se guarda únicamente en Railway y en el encabezado HTTP de Dapta, nunca en herramientas de voz, variables de llamada, exports, archivos versionados ni logs. Los JSON y el patch usan `Bearer NEW_PRIVATE_IDENTITY_FLOW_TOKEN` como placeholder que debe hidratarse solo en memoria antes del preview. Publicar primero el backend autenticado y el parser; después publicar el flow y la herramienta como un cambio coordinado. El guion bloquea producto, importes y fechas ante cualquier respuesta sin `ok=true`, `verificado=true` y `condiciones.speech` completo.

El endpoint devuelve `{ok:true,verificado:true,condiciones:{...}}` o `{ok:true,verificado:false}`. Ante una identidad no verificada, el guion permite aclarar primero el nombre y después la cédula; con `DOCUMENT_NOT_UNDERSTOOD` prioriza la cédula. Si ese code persiste y la aclaración de cédula ya se utilizó, termina sin otra consulta; repetir el nombre solo se permite si el documento se interpreta y la nueva respuesta es una identidad no verificada sin ese code. Cada aclaración espera una nueva respuesta y conserva literalmente el último otro dato y el mismo `event_id`, sin señalar cuál dato falló ni sugerir el registrado. El límite es tres consultas en toda la llamada, incluidas las respuestas `DOCUMENT_NOT_UNDERSTOOD`, y una aclaración por dato, incluidas las repeticiones previas a la primera consulta. Un error o un límite agotado termina con revisión de un asesor y despedida, sin condiciones financieras. El flow solo reenvía ese code reconocido; otros errores quedan sin detalles internos. Las condiciones verificadas contienen inicial, cuota comercial, cantidad de cuotas, frecuencia y calendario real del plan definitivo. `condiciones.speech` prepara importes completos en palabras, cantidad de cuotas con frecuencia, primera fecha en español y los importes de cada cuota. La conversión es determinista y sale del mismo snapshot verificado; el agente lee esos textos literalmente, sin calcular ni abreviar cifras. El flow y el guion bloquean la explicación si falta algún texto requerido. La voz conserva el idioma `es-419` y el mismo identificador de voz, con modelo `eleven_multilingual_v2`, velocidad 1 y temperatura 1, manteniendo la normalización activa. Sin verificación no devuelve importes, documento ni celular.

### Guion, voz y referencia del celular

Diana abre con «Hola, soy Diana de FINSER PEY y quiero darle la bienvenida y confirmar los datos de la financiación de su celular. Esta llamada está siendo grabada y monitoreada para efectos de calidad y seguridad. ¿Me confirma, por favor, su nombre completo?». Espera ese nombre y después pregunta «¿Su número de cédula, por favor?». No pide otra autorización ni pregunta si tiene un momento. Las descripciones de la herramienta requieren respuestas reales de la persona y no contienen variables con la identidad esperada; un «sí» no es un nombre ni una cédula. Un rechazo de la grabación termina la atención sin condiciones financieras.

Cuando la respuesta de identidad contiene `ok=true`, `verificado=true` y `condiciones.speech` completo, Diana dice «Le confirmo su plan de pagos». `speech.equipmentReference` puede aportar la referencia real del celular preparada por el backend como string o `null`; si existe la menciona literalmente antes de los importes. Si falta, la omite y cualquier pregunta sobre ella requiere revisión; no inventa marca, modelo, capacidad ni una referencia sustituta. Las diferencias o rechazos de un bloque quedan registrados para un asesor.

El guion tiene tres bloques separados, cada uno con «¿Está de acuerdo?» pronunciado con entonación interrogativa, nunca como una afirmación, y una nueva respuesta antes de avanzar: producto disponible/inicial/cantidad de cuotas/valor; calendario y primera fecha; bloqueo del aplicativo por mora y activación que puede tardar hasta 24 horas después del pago. El agente termina la salida de cada pregunta sin herramientas y espera otra intervención; no lee los signos de interrogación ni utiliza SSML. Los días dos y diecisiete solo se dicen si el calendario real los confirma. Para otra frecuencia se conserva el texto verificado y se omiten esos días. Si las cuotas tienen valores distintos se leen los importes preparados en orden, sin anunciar una cuota uniforme.

El agente no ejecuta `end_call` en el mismo turno de una pregunta ni mientras espera una respuesta. El cierre normal exige los tres acuerdos en tres intervenciones nuevas del cliente, sin reutilizar un «sí» u «ok» ni suponer acuerdos mediante variables. Después de escuchar el tercer acuerdo, Diana debe decir en voz alta exactamente «Gracias por su tiempo.» y solo después invocar `end_call`, sin una cuarta pregunta. La despedida corresponde a una salida hablada del agente previa a la herramienta.

`pendingEndCallTool` y `end-call-goodbye.patch.json` desactivan el habla nativa mediante `speak_during_execution=false` para evitar otra despedida si un runtime interpreta ese ajuste. Los campos existentes `execution_message_type=static_text` y `execution_message_description=Gracias por su tiempo.` se conservan, pero quedan inactivos: no son la fuente de la despedida. Los campos pertenecen a [EndCallTool en el SDK oficial de Retell](https://github.com/RetellAI/retell-typescript-sdk/blob/main/src/resources/llm.ts#L5463-L5501). Dapta confirmó su persistencia, pero el mensaje nativo no se oyó en la prueba de LiveKit examinada. El patch actualiza únicamente esa herramienta por nombre y conserva la herramienta privada de identidad. Este ajuste de guion y configuración todavía requiere una prueba acústica autorizada; no garantiza que el motor espere a terminar la reproducción antes de colgar. Esa espera corresponde al motor de llamadas de Dapta.

La prueba controlada posterior con Angie siguió sin despedida audible, aunque los tres acuerdos sí tuvieron respuestas reales. LiveKit informó 934 caracteres enviados a TTS y 911 reproducidos; los 23 restantes coinciden con la longitud de «Gracias por su tiempo. » incluido el espacio final. Esto es compatible con audio pendiente cortado al ejecutar `end_call`, sin demostrar el contenido no expuesto del LLM. El evaluador de la transcripción falla por despedida ausente. El cierre **sigue sin resolver**: el requisito es terminar la frase y colgar inmediatamente después. El usuario descartó depender del timeout de silencio; esa alternativa no se aplicó. No se habilitan llamadas generales. Dapta debe exponer o corregir la espera de reproducción de su adaptador; LiveKit documenta [RunContext.wait_for_playout](https://docs.livekit.io/agents/multimodality/audio/) y el [EndCallTool que espera la salida hablada](https://docs.livekit.io/reference/python/livekit/agents/beta/tools/end_call.html). No añadir campos sin soporte documentado ni un retraso fijo como sustituto de esa espera.

Se conservan las salidas anticipadas por rechazo, identidad no verificada después de agotar la recuperación permitida, fallo, diferencia que necesita asesor, petición expresa de terminar o buzón. En una salida dirigida a una persona, Diana da la explicación apropiada sin preguntas, dice «Gracias por su tiempo.» y solo después invoca `end_call`. En buzón no revela datos personales ni financieros; si el agente realiza el cierre, dice únicamente esa despedida antes de la herramienta. El colgado automático del detector de buzón y el timeout automático de silencio permanecen separados.

Una transcripción equivocada antes de invocar la herramienta no debe corregirse sustituyéndola por el nombre esperado. `voice_language=es-419`, `stt_mode=accurate` y la voz seleccionada son ajustes del agente, no evidencia del proveedor, modelo ni idioma efectivos del reconocedor de una sesión. Los diagnósticos examinados no exponen esos tres datos ni métricas ASR útiles. La recuperación del guion mitiga un fallo de captura; no prueba que el motor de reconocimiento esté corregido. Mantener el verificador exacto y solicitar al proveedor el STT resuelto, transcripción inicial/final, endpointing y procesamiento aplicados antes de atribuir la causa a un ajuste concreto.

El guardado de la voz paisa en la interfaz cambió incidentalmente `enable_transcription_formatting` de `null` a `true`; no se ha probado una relación causal con el fallo de reconocimiento. Después del retorno a «Lina - Carefree & Fresh», el usuario eligió probar «Angie», vendedora colombiana; el borrador refleja el identificador de voz confirmado en Dapta, sin atribuirle una corrección del reconocimiento. El preview no aplica valores `null` para restaurar campos vacíos, por lo que no se afirma una restauración de esos ajustes ni se adivinan sus valores predeterminados.

Los importes, la cantidad de cuotas y la primera fecha siguen siendo los textos literales de `speech`, con voz conversacional y sin abreviarlos. La naturalidad y la pronunciación se comprueban escuchando la grabación de la prueba autorizada; una transcripción correcta no prueba claridad audible.

El análisis conserva la identidad verificada por la respuesta real de la herramienta y separa `payment_plan_confirmed`, `first_payment_confirmed` y `device_policy_confirmed`. `terms_confirmed` exige identidad válida y los tres acuerdos, sin reutilizar un «sí» entre bloques. `recording_accepted` describe continuidad después del aviso sin rechazo, no una autorización expresa que no se solicitó. Un cierre con respuesta pendiente no es una bienvenida completa.

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

Al desplegar el esquema de repeticiones manuales, mantener el interruptor global apagado hasta que termine el predeploy y esté activa la nueva versión. El índice de unicidad incorpora `attemptNumber`; el código anterior usa un conflicto de dos columnas y no debe ejecutarse durante esa transición. Los registros anteriores conservan `attemptNumber=0`, la bienvenida automática sigue siendo única y la cola excluye intentos posteriores.

### Ejecutar únicamente la prueba dirigida

Desde el checkout completo, con dependencias de desarrollo instaladas y las variables privadas ya disponibles en un entorno autorizado, mantener explícitamente `DAPTA_WELCOME_VOICE_ENABLED=false` y ejecutar:

```sh
node scripts/test-credit-welcome-voice.mjs --credit-id ID_CREDITO_PRUEBA --expected-phone +57CELULAR_REGISTRADO --test-phone +57NUMERO_PERSONAL_AUTORIZADO
```

Este comando solicita una llamada real, únicamente al número personal autorizado indicado explícitamente en `--test-phone`. `--expected-phone` debe coincidir con el celular registrado del crédito y funciona solo como guardia; nunca se usa como destino de esta prueba. Los dos números pueden ser diferentes. El helper no cambia el contacto del crédito ni el snapshot guardado: después de revalidar esos datos, reemplaza únicamente el destino en una copia temporal del snapshot que recibe el dispatcher. La identidad se verifica contra el nombre y documento reales del crédito seleccionado, y el resultado queda vinculado a ese crédito.

La fábrica habilitada existe solo en ese proceso y no modifica el interruptor del servicio. El helper inserta o reutiliza el evento `PENDING` de ese crédito y lo reclama por su identificador, con origen auditado `CONTROLLED_TEST`; conserva pendientes los eventos de otros créditos. Revalida contacto, condiciones y saldo antes de la solicitud a Dapta. Sin `--repeat-of`, un evento ya intentado (`DISPATCHING`, `ACCEPTED`, `UNKNOWN` o cualquier estado cerrado) impide otra llamada. La ausencia o invalidez de `--test-phone` detiene el comando, sin reemplazarlo por el número del cliente.

Solo para una nueva prueba expresamente autorizada después de una llamada controlada terminada, añadir `--repeat-of UUID_EVENTO_TERMINADO` al mismo comando. El UUID identifica el evento anterior, no el identificador de llamada de Dapta. El store exige que ese evento sea `CONTROLLED_TEST`, esté `COMPLETED` y pertenezca al mismo crédito; crea un evento nuevo con vínculo al anterior y número de intento auditado, sin reiniciar ni cambiar el resultado anterior. El helper firma el token del evento nuevo y rechaza que el store devuelva el padre. Cada evento anterior admite una sola repetición explícita; volver a ejecutar el mismo comando no solicita otra llamada. Los eventos pendientes, aceptados, ambiguos o de otro crédito no habilitan esta excepción. El número de prueba sigue siendo obligatorio y la función global debe permanecer apagada.

La salida contiene solo `eventId`, `creditId` y `status`; no muestra número, URL privada, token ni condiciones. `ACCEPTED` significa que Dapta devolvió el identificador de llamada, no que la persona contestó. `UNKNOWN` exige conciliar el registro de Dapta y el callback; volver a ejecutar el comando no redespacha ese evento. El intento inicial de prueba conserva la unicidad por crédito de la llamada normal, por lo que habilitar posteriormente la función no vuelve a llamar a ese crédito; los intentos explícitos posteriores conservan su propia relación de auditoría.

La importación automática del archivo de audio permanece pendiente del contrato de descarga privada de Dapta. No se garantiza audio para llamadas no conectadas ni retención indefinida.

### Comprobar la secuencia de una llamada terminada

`scripts/verify-credit-welcome-voice-call.mjs` evalúa un JSON local saneado de `get_call`, directo o envuelto en `call`. Conservar únicamente `transcript_with_tool_calls` (roles, contenido y tiempos) y `tool_calls` (nombre, tipo, tiempos y resultado de identidad). Excluir argumentos, variables, identificadores, teléfonos, URL y credenciales antes de guardarlo. El archivo debe permanecer privado y fuera de Git.

```sh
node scripts/verify-credit-welcome-voice-call.mjs --input RUTA_JSON_PRIVADO_SANEADO
```

La salida contiene códigos y conteos, sin texto del cliente. Comprueba el resultado verificado antes del plan, las respuestas independientes a los tres bloques y la despedida transcrita antes de `end_call`; admite aclaraciones y preguntas repetidas del mismo bloque. `PASS` solo acredita esa secuencia en la transcripción; no prueba entonación, audio audible, reproducción completa ni comportamiento futuro. El evaluador es conservador con respuestas ambiguas y solo evalúa el cierre normal: un buzón o una salida anticipada requieren revisión por separado. Los flags de análisis del modelo y un mensaje nativo configurado no sustituyen la evidencia de conversación. Los códigos de salida son 0 para `PASS`, 1 para `FAIL` y 2 para `INCONCLUSIVE`.

## Referencias

[Registro y descarga de llamadas](https://changelog.dapta.ai/), [nodo Dapta Phone Call](https://docs.dapta.ai/flow-studio/nodes/dapta-phone-call), [variables dinámicas](https://docs.dapta.ai/ai-voice-agents/how-to-set-up-your-ai-voice-agent/using-dynamic-variables), [webhook](https://docs.dapta.ai/integrations/webhook-set-up).
