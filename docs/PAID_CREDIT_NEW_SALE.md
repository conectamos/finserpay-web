# Nueva venta después de pagar un crédito

Un crédito saldado no reserva para siempre la cédula del cliente. Se comprueba
el monto vigente del crédito contra la suma de sus abonos no anulados, con el
mismo criterio de saldo usado por la elegibilidad de segundo crédito. No se
descuenta nuevamente la cuota inicial. Los ajustes ya confirmados de abono a
capital o liquidación anticipada forman parte del monto vigente guardado.

Cuando no hay saldo pendiente ni otra solicitud que reserve la identidad, se
permite iniciar una venta por cualquier aliado, sede o asesor autorizado. La
nueva solicitud pertenece a quien la inicia; no se modifica el propietario, el
contrato, los pagos ni la trazabilidad del crédito anterior. Se mantienen los
locks por cédula para evitar solicitudes y cierres concurrentes duplicados.

Una evaluación DataCrédito consumida conserva su vínculo histórico y no puede
reutilizarse para el crédito nuevo. Si el crédito que la consumió está saldado,
se permite iniciar una evaluación nueva mediante el flujo normal, manteniendo
consentimiento, límites de consulta, política del aliado y controles de identidad,
firma y entrega. Consultar el historial no inicia una evaluación.

El muro presenta la solicitud posterior al cierre del crédito histórico mientras
esa nueva solicitud no haya liberado la identidad, incluidos sus rechazos y
errores. Las solicitudes antiguas no desplazan al crédito que las finalizó.

`npm run test:credit-renewal` ejecuta regresiones con SQL real en bases PGlite
aisladas, sin consultas pagas, contratos reales ni cambios de créditos productivos.
