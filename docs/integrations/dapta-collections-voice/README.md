# Cobranza automática por voz — Valeria

## Estado del borrador

Documentación local para el agente `FINSERPAY — Cobranza por mora (Valeria)`, UUID `546f13ab-19cf-47a3-bb13-49240e42ec6b`, workspace FINSERPAY `7496b9a3-2fe6-4e28-8411-7d54ee788b2c`. No se publica ni activa desde estos archivos.

En el diagnóstico del 9 de octubre de 2026 había 104 candidatos financieros por mora y ningún consentimiento auditable registrado para el canal de voz. Esa elegibilidad financiera y la autorización del operador para desarrollar la integración no constituyen autorización del cliente para recibir llamadas. El lote permanece inactivo hasta que el backend disponga de la evidencia exigida por la política. No fabricar, inferir ni importar como aceptados consentimientos ausentes. El aviso de grabación durante una llamada tampoco crea retroactivamente esa autorización.

La lectura remota confirmó cero llamadas de cobranza ese día, herramientas de Valeria limitadas a `end_call` y callback hacia `7atXD`. La única secuencia de cobranza estaba terminada y limitada al 15 de septiembre. El registro posterior estaba conectado; faltaban el marcador automático y la verificación/consulta durante la llamada. El borrador no afirma que esas conexiones nuevas ya existan.

## Política que debe aplicar el backend

- Revalidar antes de reservar y antes de llamar: consentimiento auditable del canal, mora vigente, celular vigente del titular, estado del crédito y suspensión por pago/acuerdo/solicitud de no contacto.
- Aplicar como máximo un contacto diario y la restricción semanal entre canales de la política operativa. Consultar el historial común, incluidos WhatsApp y gestiones humanas; no limitar el control a este worker ni considerar un ledger incompleto como ausencia de contactos. Definir en el contrato final qué consume cada límite y aplicar la misma definición en todos los canales.
- Reservar de forma durable y evitar que workers concurrentes, reinicios o callbacks repetidos dupliquen llamadas. Un resultado ambiguo no autoriza redespachar a ciegas.
- No compartir saldos, mora, documentos ni mensajes de cobranza con familiares o referencias. El destinatario debe corresponder al titular verificado.
- Mantener secretos, grabaciones y transcripciones privados. Los reportes operativos solo contienen contadores y códigos seguros.

Son requisitos del sistema; el prompt no sustituye su aplicación en el servidor. Una falta de consentimiento, de historial necesario o de configuración mantiene el envío bloqueado.

La coexistencia con los tres workers de WhatsApp todavía requiere coordinación transaccional de los límites compartidos. Mientras estén activos y esa coordinación no esté implementada y comprobada, el gate de cobranza por voz permanece desactivado. Este borrador no declara el lote listo ni autoriza desplegarlo.

## Origen obligatorio y flujo saliente

Todas las llamadas deben salir de **`+573124085562`**. Dapta lo inventarió como SIP privado FINSERPAY, `voice_capable=true` y `verification_status=success`. El origen debe ser una constante del nodo nativo `custom.dapta_phonecall`, en `custom_action.values.from_number`; no aceptarlo desde el cliente ni permitir el pool compartido estadounidense como fallback. Si la línea no está disponible, no llamar.

El flujo de cobranza debe usar exclusivamente el agente Valeria. No reutilizar el flujo WdOvp sin cambiar su contrato: está vinculado al agente de bienvenida. No reasignar la ruta entrante del trunk ni el agente de cobranza antiguo para establecer este origen saliente.

El evento del outbox suministra únicamente `event_id`, `credito_id` y `event_token` como variables de llamada. El modelo recoge nombre y cédula de las respuestas; no recibe identidad esperada que permita autoverificarse. El token original sirve para correlación/autenticación del callback; no se copia por el modelo en la herramienta de identidad.

La herramienta MCP de actualización de agente no expone setters de `voice_agent_phone_number`, `caller_id_type` o `sip_trunk_id`. La fijación documentada aquí corresponde al flujo saliente; no garantiza llamadas manuales de un widget fuera de ese flujo. Esas superficies deben revisarse antes de prometer que todo origen posible quedó fijado.

## Herramientas y contratos

Los nombres aprobados son `verificar_cliente_cobranza` y `registrar_gestion_cobranza`. Sus definiciones Dapta, endpoints pendientes y campos aún no confirmados se completan antes del preview; no crear herramientas huérfanas ni inventar respuestas. Todos los parámetros individuales de herramientas de voz son strings. Las credenciales se configuran en encabezados privados de nodos HTTP, nunca como datos que el LLM deba copiar. No guardar tokens ni URLs privadas en Git.

### Identidad y mora fresca

Contrato propuesto por el backend: `POST /api/integraciones/cobranza/voz/identidad`, body `{event_id, customer_name, customer_document}`, autenticado por bearer privado fuera del modelo. Recibe nombre y documento literales de la conversación, interpreta el documento de forma determinista y verifica contra el evento acotado. No consulta otro crédito ni relaja el documento por una coincidencia de nombre.

La identidad verificada devuelve crédito consultado en ese momento: `creditId`, `diasMora`, `valorVencido`, `ultimoPago` y `moneda:"COP"`. No se necesita una consulta financiera separada si esta respuesta ya es fresca y revalida la suspensión de cobranza. La respuesta inválida/no verificada no expone datos financieros. Los códigos y límites de aclaración definitivos deben coincidir con el backend; el guion permite una aclaración por dato en toda la llamada y respeta el límite total del servidor.

El contrato de voz confirmado añade `credito.speech.valorVencido:string` (incluye pesos) y `credito.speech.diasMora:string` (incluye días), derivados de esa misma consulta. El prompt exige ambos textos no vacíos y los lee literalmente; no convierte cifras a palabras ni da por validada una pronunciación a partir de la transcripción. Publicar el backend y su herramienta como un cambio coordinado antes de usar el guion financiero.

El guion no rechaza nombres por parecer extraños ni trata «no» seguido de un nombre como rechazo. Con un nombre realmente comunicado continúa a la cédula y deja la decisión al backend. Solo un rechazo explícito o una petición inequívoca de finalizar permiten cerrar por ese motivo.

### Gestión durante la llamada

`registrar_gestion_cobranza` usa `POST /api/integraciones/cobranza/voz/gestion`, con bearer privado en el nodo HTTP y body `{event_id,result,comment,next_follow_up_at}`. Los campos suministrados por la herramienta son strings; el servidor limita `result` a `MEDIOS_PAGO` o `PAGO_REALIZADO`. La operación está acotada al mismo evento e identidad verificada y debe revalidar el estado antes de persistir. No asumir que el endpoint heredado ofrece por sí solo este alcance de evento.

- `MEDIOS_PAGO`: registra la petición. `registrado:true` no significa mensaje enviado. Solo una respuesta del servidor `enviado:true` permite afirmar un envío; no pedir ni ejecutar WhatsApp si el backend bloquea ese canal por consentimiento o historial.
- `PAGO_REALIZADO`: conserva una manifestación del cliente para revisión; no aplica un abono ni certifica un saldo en cero.
- `ACUERDO_PAGO`: **no admitido por la operación actual**. Se pueden recoger literalmente fecha y valor para revisión, sin enviar otro código en su lugar ni afirmar una solicitud persistida. Una operación futura necesitará preparar los términos para lectura, esperar confirmación real del cliente y confirmar la persistencia de una solicitud pendiente de asesor. No concede una prórroga ni aprueba un acuerdo mediante texto/booleanos del LLM o del análisis posterior.

Si el backend todavía no admite un tipo de gestión, no simularlo mediante otro resultado ni afirmar que se guardó. Los textos preparados para repetir valores y fechas de una propuesta forman parte del contrato pendiente; el modelo no inventa su interpretación.

## Registro posterior firmado

El nuevo flujo de resultado hace POST a `/api/integraciones/cobranza/voz/resultado`. El receptor verifica el evento firmado y el agente esperado; usa las tres variables `event_id`, `credito_id` y `event_token`, sin exigir `finser_agent_id`. Debe conservar la deduplicación por llamada y conciliar la gestión viva con el registro posterior para no guardar dos gestiones del mismo hecho. El token no lo transporta ni reconstruye el modelo.

Este contrato reemplaza el callback heredado `7atXD` (`postcall_cobranzas`) para la integración nueva. No usar el legado ni su requisito adicional `finser_agent_id` en el nuevo flujo. La conexión remota y su guardado real siguen pendientes de validar; los archivos locales no cambian la configuración de producción.

Valeria extrae `resultado_gestion`, `observacion_gestion`, `acuerdo_confirmado`, `fecha_acuerdo`, `valor_acuerdo`, `proxima_gestion`, `pago_informado`, `whatsapp_solicitado` y `finalizar_solicitado`. Ese análisis aporta contexto y no prueba identidad, consentimiento, un pago aplicado, un envío o un acuerdo aprobado.

No ampliar silenciosamente las variables ni confiar en un agente arbitrario enviado por el modelo. El análisis posterior no sustituye la verificación de identidad ni el registro confirmado por las herramientas del servidor.

## Validación antes de cualquier lote

1. Completar y probar los contratos de identidad, speech, gestión y callback con el worker desactivado.
2. Verificar controles de consentimiento e historial entre canales con ausencia de evidencia, pagos recientes, no contacto, carreras y respuestas ambiguas.
3. Configurar el flujo separado, ambas herramientas y el prompt como un cambio coordinado; comprobar guardado real, variables, autenticación privada y origen fijo 312.
4. Realizar solamente la prueba controlada que autorice el usuario. Escuchar nombre/cédula, saldo completo y despedida; comprobar la ruta real de salida y la persistencia, no solo el HTTP 200 o el resumen.
5. Mantener el lote de candidatos bloqueado hasta registrar la evidencia requerida por cliente. Publicar código o un agente ACTIVE no equivale a autorizar ese lote.

La llamada debe pronunciar «Gracias por su tiempo» antes de `end_call`. En el runtime LiveKit se reprodujo antes un corte de audio pendiente al ejecutar esa herramienta; una instrucción escrita no demuestra que el motor haya drenado el audio. No presentar la despedida audible como verificada hasta escuchar la prueba autorizada o contar con una corrección del proveedor comprobada.
