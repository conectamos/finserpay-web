# Abonos parciales a cuotas

En Abonos y recaudo, «Abono parcial u otro valor» permite indicar un importe
menor que el saldo de las cuotas seleccionadas. El resumen y la confirmación
muestran el saldo que quedará pendiente. El dinero recibido debe cubrir el
importe a aplicar; el excedente recibido sigue siendo cambio para entregar.

La imputación conserva el orden cronológico del plan. Un parcial no marca la
cuota como pagada, no cambia su vencimiento y no elimina la mora del saldo
vencido. Al completar el saldo, el plan avanza a la siguiente cuota. Los
redondeos contractuales, protecciones por prórroga o excepción, permisos,
comprobantes e historial conservan sus reglas existentes.

El servidor acepta únicamente importes positivos y no permite superar el saldo.
La pantalla envía `totalAbonadoEsperado`, que se compara con el total vigente
bajo el bloqueo del crédito antes de crear el abono y su movimiento de caja.
Un reintento o una pantalla desactualizada recibe `409 / PAYMENT_PLAN_CHANGED`
sin registrar otro pago; se actualiza el plan y se exige revisar la selección.
Los errores de red conservan los datos y nunca reenvían automáticamente el pago.

Abono a capital y liquidación anticipada mantienen sus flujos independientes.
Las pruebas locales se ejecutan con `npm run test:credit-payments`, sin pagos
reales ni conexiones a proveedores.
