# Cobranza de voz FINSERPAY

Valeria usa la cartera y las gestiones de FINSERPAY. El flujo no escribe en Google Sheets. El responsable se obtiene de `FINSERPAY_COBRANZA_ACTOR_ID`; los acuerdos requieren titularidad verificada, aceptación expresa, fecha y valor válidos. Un pago declarado queda pendiente de validación y suspende los siguientes cobros automáticos.

## Conexiones

- Agente de voz: `546f13ab-19cf-47a3-bb13-49240e42ec6b`.
- Herramientas y cierre: flujo `7atXD`, POST `/api/integraciones/cobranza/operacion`.
- Despacho de llamadas: flujo `lMQob`; FINSERPAY autoriza una sola marcación por sesión antes de usar la acción nativa de telefonía.
- Plantillas posllamada: flujo `41UnZ`; canal de Diana, únicamente `medios` o `soporte`, con sus respuestas entrantes conservadas en Diana.

Las URL de los webhooks contienen credenciales y solo deben configurarse como secretos de despliegue.

## Configuración

`FINSERPAY_COBRANZA_API_TOKEN`, `FINSERPAY_COBRANZA_AGENT_ID`, `FINSERPAY_COBRANZA_ACTOR_ID`, `DAPTA_COBRANZA_CALL_WEBHOOK_URL`, `DAPTA_COBRANZA_MESSAGE_WEBHOOK_URL`. Para habilitar: `DAPTA_COBRANZA_ENABLED=true` y `DAPTA_COBRANZA_LIVE_READY=true`. El valor inicial de ambos interruptores es falso hasta completar la verificación operativa.

`DAPTA_COBRANZA_REFERENCES_OWNED=true` permite usar referencias solamente cuando el administrador haya verificado que pertenecen al titular y están autorizadas. Se normalizan y eliminan duplicados. Cada intento cuenta por documento, no por teléfono. El orden es teléfono principal, referencia 1 y referencia 2.

La prueba usa exclusivamente `DAPTA_COBRANZA_TEST_DOCUMENT` y `DAPTA_COBRANZA_TEST_PHONE`, configurados por el administrador para una prueba autorizada en su propio celular. `action=testcall` no acepta un destino arbitrario en el cuerpo. Mantiene la consulta y la verificación real, pero utiliza un libro de intentos separado de los contactos al cliente y no crea gestiones ni acuerdos ficticios en la cartera. Permite probar con `DAPTA_COBRANZA_LIVE_READY=true` y `DAPTA_COBRANZA_ENABLED=false`; esta excepción solo autoriza el teléfono de prueba configurado. El envío de una plantilla aceptada en la prueba sí es real.

## Ejecución y límites

El cron interno revisa cada 30 segundos. Las ventanas de no respuesta son 10:00, 14:00 y 17:00 de lunes a viernes, y 08:00, 10:00 y 14:00 los sábados, durante los primeros diez minutos de cada ventana. No llama domingos ni festivos colombianos. Una ejecución manual también debe respetar el horario legal. El límite es tres intentos diarios por titular; después de un contacto humano no se marca nuevamente ese día. No hay reintento automático a cinco minutos tras contacto humano.

La exclusión consulta gestiones manuales y los libros existentes de WhatsApp y bienvenida. Es conservadora: una aceptación o un resultado incierto de otro canal puede suspender la selección. Estos otros procesos no comparten aún el mismo bloqueo transaccional, por lo que esta lectura no garantiza una exclusión global ante envíos simultáneos de campañas independientes. Revisar la coordinación antes de programar otras campañas para los mismos titulares.

Un acuerdo detiene el cobro hasta su fecha de seguimiento; si continúa en mora, permite un seguimiento vinculado al acuerdo y deja de repetirlo tras contactar. La ausencia de mora detiene la selección. El pago informado requiere revisión humana para validar recaudo. Los estados jurídicos no disponibles se devuelven como desconocidos y no habilitan advertencias.

`CollectionVoiceAttempt` conserva autorización, teléfono, recibo del proveedor, verificación, resultado y estado del mensaje. Un resultado incierto se retiene para conciliación y no se reenvía automáticamente. La respuesta HTTP 200 por sí sola no acredita una llamada ni un WhatsApp: se exige identificador del proveedor. El mensaje solo se solicita si el titular lo acepta; soporte corresponde a pago informado. Una petición de finalizar excluye nuevos contactos de este agente.

## Verificación

Ejecutar las pruebas `collection-voice-policy`, `collection-voice-runtime`, `collection-voice-ledger`, `dapta-collections-http` y `analyst-mora`, además de TypeScript. Después del despliegue comprobar autorización, selección sin envío y una llamada autorizada. El ticket Dapta #143326236 sobre la despedida requiere escuchar la grabación; el texto del prompt no acredita que esté resuelto.
