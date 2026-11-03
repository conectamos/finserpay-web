# Recaudo por corte

Disponible en **Cartera → Recaudo por corte**, debajo de **Riesgo por referencia**, para administradores. Los supervisores acceden según su sede. También figura en el centro de reportes. Ruta: `/dashboard/reportes/recaudo-por-corte`.

## Uso

Seleccionar corte 02 o 17, mes, año, aliado, sede y estado; pulsar **Consultar corte**. No se guarda ninguna proyección. El reporte compara las cuotas con vencimiento exactamente en la fecha seleccionada con todo el efectivo vigente aplicado a ellas, hasta la hora de consulta. El estado filtra simultáneamente tarjetas, tabla y Excel. La descarga contiene Resumen, Cuotas y Pagos aplicados.

## Fuente y cálculo

La fuente de efectivo es `CreditoAbono`. Caja, intenciones Wompi e importaciones Efecty no se suman adicionalmente porque representan los mismos abonos. El alcance corresponde a la sede **del crédito**, aunque una sede recaudadora diferente haya recibido el pago.

La plataforma no mantiene una tabla persistida de distribución pago→cuota. El reporte reutiliza `buildCreditPaymentPlan` y reconstruye la asignación FIFO en el orden del recibo oficial (`fechaAbono`, luego ID). Los anulados, reversados, revertidos o eliminados no cuentan. Se conservan las cuotas ya pagadas en su calendario: `fechaProximoPago` es un cursor móvil y no desplaza cortes anteriores.

- **Créditos del corte:** créditos distintos de las cuotas visibles.
- **Esperado:** valor completo programado de las cuotas del corte.
- **Recibido:** efectivo vigente aplicado a esas cuotas, incluidos anticipos, pagos del día y pagos posteriores al vencimiento.
- **Anticipos incluidos:** parte del recibido cuya fecha efectiva es anterior a las 00:00 del corte en `America/Bogota`. No se suma nuevamente al recibido.
- **Pendiente:** `máximo(0, esperado − recibido)` por cuota.
- **Cumplimiento:** `recibido / esperado × 100`; si esperado es cero, **No aplica**.
- **Clientes pendientes:** documentos distintos normalizados con saldo pendiente; cuando falta el documento se conserva una identidad por crédito.

La recuperación de cuotas anteriores y los anticipos de cuotas futuras se muestran aparte. Incluyen pagos desde el inicio del corte hasta la consulta, aplicados a otros vencimientos de los créditos visibles; se deduplican por crédito. No representan todos los ingresos diarios de la empresa.

## Cronograma vigente y conciliaciones

La consulta usa el cronograma vigente, incluidas modificaciones reales de fechas y capital. No es una fotografía histórica inmutable. Excluye cuotas eliminadas, créditos anulados y créditos con paz y salvo emitido antes del inicio del corte. Un cierre desde ese día no se convierte en efectivo recibido: se muestra una observación para distinguir la diferencia de recaudo de una deuda exigible.

Los planes de capital usan `planCapitalVigente`, validando identidades y valores de sus abonos base. El efectivo conciliado por cuota se incluye una sola vez como `reconciledReceived`; los recibos fuente muestran su valor bruto informativo y no reciben asignaciones individuales inventadas. La pantalla y el Excel separan ese agregado para cuadrar el detalle de pagos con el recibido.

Si todas las fuentes son anteriores al corte, el agregado es anticipo; si son del corte o posteriores, no lo es. Si mezclan ambos periodos sin una distribución individual, se conserva en recibido y se informa como importe sin fecha de atribución, sin inventar su proporción de anticipos ni su última fecha de pago. Una conciliación de capital realmente inconsistente produce un error explícito; no se sustituye por un cronograma inventado.

## Permisos y conservación de datos

- Administrador central: todas las sedes autorizadas.
- Administrador de aliado: sedes de su aliado de acceso.
- Supervisor: su sede operativa autorizada.
- Vendedores y sesiones ausentes: acceso denegado.

La consulta se ejecuta en una transacción `REPEATABLE READ` mediante lecturas. No modifica créditos, pagos, saldos ni proyecciones. Las proyecciones anteriores permanecen en `CutCollectionProjection`, con su protección contra UPDATE/DELETE; el reporte directo no depende de esa tabla ni de una nueva migración.

GET `/api/reportes/recaudo-por-corte` acepta los filtros y `format=xlsx`. Los enlaces antiguos con `projectionId` o `historyPage` consultan directamente la fecha seleccionada e ignoran esos parámetros. POST valida acceso y devuelve 410, sin escribir. Todas las respuestas del módulo son privadas y sin caché.

## Verificación

`node --experimental-strip-types --test tests/cut-collection*.test.mjs` cubre cálculo, anticipos, parciales, pagos tardíos, reversos, capital, créditos pagados, permisos, sedes, tarjetas, tabla, Excel y conservación del histórico anterior.

`scripts/verify-cut-collection-production.mjs --cut YYYY-MM-DD` verifica cuentas existentes, permisos, filtros, enlaces antiguos, exportación y huellas de créditos y pagos antes/después. Usa solo GET y SQL de lectura; recibe `DATABASE_URL` y `SESSION_SECRET` del entorno sin imprimir credenciales ni datos de clientes.
