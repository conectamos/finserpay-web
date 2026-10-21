# Una sola llamada automática de bienvenida

Desde el 20 de octubre de 2026, cada crédito admite una sola llamada automática de bienvenida. Esta política reemplaza los cinco intentos y la insistencia diaria que documentaba anteriormente este archivo.

La primera llamada se encola al confirmar el crédito definitivo. El worker conserva la llamada inicial pendiente y comprueba nuevamente el estado del crédito, sus condiciones, teléfono y exclusiones antes de despacharla.

No se crean reintentos cada cinco minutos ni en las franjas 08:00, 10:00, 14:00 y 17:00. Un buzón, ocupado, ausencia de respuesta o fallo no habilita otra llamada automática. Una respuesta incierta tampoco se redespacha.

El límite se comparte entre NORMAL, INDIVIDUAL_IMPORT, AUTOMATIC_RETRY y SCHEDULED_CAMPAIGN, bajo el bloqueo del crédito. La preparación anterior al HTTP también comprueba el límite para rechazar reintentos reclamados previamente. El número de secuencia de un evento, por sí solo, no demuestra una llamada realizada.

La instalación del esquema detiene los seguimientos y miembros de campaña que ya tienen un intento, con motivo AUTOMATIC_CALL_LIMIT_REACHED, y cancela los reintentos pendientes claramente no enviados. Conserva las llamadas en curso, los resultados, las grabaciones y la recepción de callbacks autenticados tardíos. El resumen de limpieza contiene únicamente cantidades y códigos operativos.

Una grabación manual en CreditApprovalCallRecording sigue deteniendo la bienvenida automática con motivo CALL_RECORDING_SAVED. Se mantienen las exclusiones por solicitud del operador, negativa, crédito anulado o pagado y cambios en las condiciones del crédito.

El botón «Llamar ahora» y las pruebas controladas siguen siendo acciones explícitas independientes. No se ejecutan como parte de la comprobación de esta política. La bienvenida de WhatsApp y las campañas de cobranza conservan sus propios procesos.
