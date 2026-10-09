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

`POST /api/integraciones/dapta/bienvenida-voz/identidad` recibe JSON con `event_id`, nombre y cédula literal. El nodo `qryId` envía `Authorization: Bearer ...` con `DAPTA_WELCOME_VOICE_IDENTITY_FLOW_TOKEN`; el backend autentica el encabezado en tiempo constante y resuelve únicamente el snapshot de ese evento, con antigüedad máxima de 24 horas y estado `DISPATCHING`, `ACCEPTED` o `UNKNOWN`. Persiste un máximo de tres consultas de identidad, incluidas las que no pueden interpretar el documento, y las aclaraciones que ya ordenó.

En este transporte privado basta que coincida al menos un nombre o apellido registrado como palabra completa tras normalizar tildes y mayúsculas; se excluyen de, del, la, las, los e y. No se admiten parecidos ni fragmentos de palabra. Siempre exige el documento completo exacto, incluidos sus ceros. La herramienta sigue recibiendo toda la respuesta literal del nombre; el modelo no elige ni revela la palabra coincidente. El modo anterior con token firmado conserva su regla de matching previa.

El modo anterior del endpoint con `event_token` firmado permanece compatible, pero este nuevo flow no lo envía. El bearer privado se guarda únicamente en Railway y en el encabezado HTTP de Dapta, nunca en herramientas de voz, variables de llamada, exports, archivos versionados ni logs. Los JSON y el patch usan `Bearer NEW_PRIVATE_IDENTITY_FLOW_TOKEN` como placeholder que debe hidratarse solo en memoria antes del preview. Publicar primero el backend autenticado y el parser; después publicar el flow y la herramienta como un cambio coordinado. El guion bloquea producto, importes y fechas ante cualquier respuesta sin `ok=true`, `verificado=true` y `condiciones.speech` completo.

El endpoint devuelve ocho campos: `ok`, `verificado`, `condiciones`, `code`, `nextAction`, `remainingAttempts`, `question` y `mayEndCall`. El servidor elige la recuperación, sin dar identidad esperada ni detalles de la coincidencia:

- `ASK_NAME` o `ASK_DOCUMENT`: `ok=true`, `verificado=false`, `condiciones=null`, `remainingAttempts` entero de uno a dos y `mayEndCall=false`. Diana lee exactamente la pregunta fija recibida, termina el turno, escucha la nueva respuesta y reconsulta el mismo evento cambiando solo ese dato literal. No se despide ni ejecuta `end_call`.
- `REVIEW`: cero consultas restantes, `mayEndCall=true` y pregunta fija «No pude confirmar sus datos. Un asesor revisará su caso.». Diana la dice, se despide y no vuelve a consultar ni revela finanzas.
- `CONTINUE`: `ok=true` y `verificado=true` booleanos, `code=null`, `question=null`, `mayEndCall=false`, `remainingAttempts` entero de cero a dos y condiciones con speech completo. El éxito en la tercera consulta permite seguir con los tres acuerdos.

Ante un fallo de reconocimiento, `ASK_NAME` pide solo el primer nombre y `ASK_DOCUMENT` pide la cédula completa desde el primer dígito, con pausas entre números. El agente conserva la respuesta literal; no une versiones ni completa datos usando el expediente. El validador del flow admite las preguntas anteriores y nuevas solo para su acción correspondiente durante el despliegue coordinado. Estas aclaraciones no cambian la comparación del documento, el presupuesto de tres consultas ni reabren eventos ya enviados a revisión.

Los false válidos usan `IDENTITY_NOT_CONFIRMED` o `DOCUMENT_NOT_UNDERSTOOD`. ASK_NAME solo se ordena si no coincide ningún componente significativo; si el nombre cumple y la cédula difiere, se pide ASK_DOCUMENT cuando está disponible. Un documento no interpretable prioriza su única aclaración y un segundo resultado no interpretable termina en REVIEW. Si se corrige, el servidor puede pedir nombre si sigue pendiente y no coincide ningún componente. No es válido deducir estas acciones de un false antiguo sin campos de control.

`qryId`, `chkId` y `rspId` transmiten los ocho campos. El validador exige tipos, límites, acciones y preguntas exactas; ante campo ausente o contradictorio responde `IDENTITY_UNAVAILABLE`, sin condiciones ni acción/pregunta inventadas. El patch de YxVoY cambia únicamente mappings y validador en cuatro operaciones; preserva entrada, normalizador, URL y encabezados privados.

Las condiciones verificadas contienen inicial, cuota comercial, cantidad de cuotas, frecuencia y calendario real del plan definitivo. `condiciones.speech` prepara los textos del mismo snapshot; el agente los lee literalmente, sin calcular ni abreviar cifras. El flow y el guion bloquean la explicación si falta algún texto requerido. Sin verificación no devuelve importes, documento ni celular. La recuperación estructurada es un borrador y necesita publicación coordinada y prueba autorizada; los controles del prompt no garantizan por sí solos que el motor bloquee físicamente `end_call`.

### Guion, voz y referencia del celular

La fuente actual del prompt vivo es el contenido posterior a `## Prompt` en `docs/DAPTA_DIANA_VOICE_PROMPT.md`. `agent-instructions.txt` conserva las mismas reglas de identidad y recuperación como borrador operativo. Las descripciones actualizadas están en `pendingIdentityTool.description`, `pendingIdentityTool.parameters.properties.customer_name.description` y `pendingEndCallTool.description` de `agent-config.draft.json`. Aplicar esos campos específicamente; el resto de la configuración es referencia histórica y no debe sobrescribir voz o credenciales vigentes. Estos archivos no afirman que el cambio nuevo ya esté aplicado.

Diana abre con «Hola, soy Diana de FINSER PEY y quiero darle la bienvenida y confirmar los datos de la financiación de su celular. Esta llamada está siendo grabada y monitoreada para efectos de calidad y seguridad. ¿Me confirma, por favor, su nombre completo?». Espera ese nombre y después pregunta «¿Su número de cédula, por favor?». No pide otra autorización ni pregunta si tiene un momento. Las descripciones de la herramienta requieren respuestas reales de la persona y no contienen variables con la identidad esperada; un «sí» no es un nombre ni una cédula. Un rechazo de la grabación termina la atención sin condiciones financieras.

Cuando la respuesta de identidad contiene `ok=true`, `verificado=true` y `condiciones.speech` completo, Diana dice «Le confirmo su plan de pagos». `speech.equipmentReference` puede aportar la referencia real del celular preparada por el backend como string o `null`; si existe la menciona literalmente antes de los importes. Si falta, la omite y cualquier pregunta sobre ella requiere revisión; no inventa marca, modelo, capacidad ni una referencia sustituta. Las diferencias o rechazos de un bloque quedan registrados para un asesor.

El guion tiene tres bloques separados, cada uno con «¿Está de acuerdo?» y una nueva respuesta antes de avanzar: producto disponible/inicial/cantidad de cuotas/valor; calendario y primera fecha; bloqueo del aplicativo por mora y activación que puede tardar hasta 24 horas después del pago. Los días dos y diecisiete solo se dicen si el calendario real los confirma. Para otra frecuencia se conserva el texto verificado y se omiten esos días. Si las cuotas tienen valores distintos se leen los importes preparados en orden, sin anunciar una cuota uniforme.

El agente no ejecuta `end_call` en el mismo turno de una pregunta ni mientras espera una respuesta. El cierre normal exige los tres acuerdos y la despedida «Gracias por su tiempo»; conserva las salidas anticipadas por rechazo, identidad no verificada, fallo, diferencia que necesita asesor, petición expresa de terminar o buzón. `pendingEndCallTool` documenta esa misma guardia. El timeout automático de silencio permanece separado.

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

## Referencias

[Registro y descarga de llamadas](https://changelog.dapta.ai/), [nodo Dapta Phone Call](https://docs.dapta.ai/flow-studio/nodes/dapta-phone-call), [variables dinámicas](https://docs.dapta.ai/ai-voice-agents/how-to-set-up-your-ai-voice-agent/using-dynamic-variables), [webhook](https://docs.dapta.ai/integrations/webhook-set-up).
