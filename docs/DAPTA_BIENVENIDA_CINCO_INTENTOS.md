# Una sola llamada automática de bienvenida

Desde el 20 de octubre de 2026, cada crédito admite una sola llamada automática de bienvenida. Esta política reemplaza los cinco intentos y la insistencia diaria que documentaba anteriormente este archivo.

Desde el 27 de noviembre de 2026, producción configura `DAPTA_WELCOME_VOICE_AUTOMATIC_FROM_HOUR=19`. Solo se encola automáticamente la bienvenida de un crédito definitivo creado desde las 19:00, hora de Colombia. Los créditos creados antes se atienden mediante el botón «Llamar ahora»; no se acumulan para un lote a las 19:00.

La selección usa `Credito.createdAt`, no la fecha comercial de apertura ni la creación del evento de llamada. La ejecución también debe ocurrir desde las 19:00 y en la misma fecha de Colombia: una cola retrasada hasta la medianoche o procedente de otra noche no autoriza una llamada automática. Se comprueba al encolar, seleccionar y preparar la llamada, incluida la vía de campañas antiguas. El resultado preparado incorpora un vencimiento interno a la medianoche colombiana del día de creación; el despachador vuelve a comprobarlo justo antes del HTTP, sin enviarlo a Dapta.

El worker comprueba nuevamente el estado del crédito, sus condiciones, teléfono y exclusiones antes de despacharla. El interruptor general `DAPTA_WELCOME_VOICE_ENABLED` permanece habilitado para conservar las llamadas explícitas. El horario automático no se aplica a `OPERATOR_REQUEST` ni a las pruebas controladas.

Una configuración horaria presente pero inválida no permite llamadas automáticas. La ausencia de la variable conserva la política anterior para instalaciones todavía no activadas. El despliegue de producción debe incluir expresamente el valor `19`; no basta con publicar el código.

No se crean reintentos cada cinco minutos ni en las franjas 08:00, 10:00, 14:00 y 17:00. Un buzón, ocupado, ausencia de respuesta o fallo no habilita otra llamada automática. Una respuesta incierta tampoco se redespacha.

El límite se comparte entre NORMAL, INDIVIDUAL_IMPORT, AUTOMATIC_RETRY y SCHEDULED_CAMPAIGN, bajo el bloqueo del crédito. La preparación anterior al HTTP también comprueba el límite para rechazar reintentos reclamados previamente. El número de secuencia de un evento, por sí solo, no demuestra una llamada realizada.

La instalación del esquema detiene los seguimientos y miembros de campaña que ya tienen un intento, con motivo AUTOMATIC_CALL_LIMIT_REACHED, y cancela los reintentos pendientes claramente no enviados. Conserva las llamadas en curso, los resultados, las grabaciones y la recepción de callbacks autenticados tardíos. El resumen de limpieza contiene únicamente cantidades y códigos operativos.

Una grabación manual en CreditApprovalCallRecording sigue deteniendo la bienvenida automática con motivo CALL_RECORDING_SAVED. Se mantienen las exclusiones por solicitud del operador, negativa, crédito anulado o pagado y cambios en las condiciones del crédito.

El botón «Llamar ahora» y las pruebas controladas siguen siendo acciones explícitas independientes. No se ejecutan como parte de la comprobación de esta política. La bienvenida de WhatsApp y las campañas de cobranza conservan sus propios procesos.
