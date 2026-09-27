# Abonos extraordinarios a capital con reduccion de plazo

## Alcance

La operacion esta separada del pago ordinario en Recaudos y solo esta habilitada
para ADMIN de FINSER PAY central. Mantiene la cuota habitual y reduce el plazo;
no adelanta cuotas ni distribuye el extraordinario entre intereses y cargos.
No registra automaticamente los casos de prueba ni modifica contratos firmados.
El flujo base requiere el esquema de revisiones de capital. La conciliacion
automatica usa la amortizacion existente y no requiere una migracion adicional.

No calcula mora, no cambia tasas generales ni aplica retroactivamente el
29,24 % EA a creditos historicos. Para el primer abono de un credito originado
en FINSER PAY, el servidor concilia automaticamente la amortizacion registrada
con el credito y sus pagos. No solicita copiar tasas, capital ni componentes
cuando dispone de esa fuente completa y consistente. Los importados masivos o
creditos sin informacion verificable conservan la conciliacion documental.
Los siguientes abonos usan los terminos de la revision ya guardada.

## Operacion

1. Registrar primero los pagos ordinarios. No sumar el extraordinario al importe
   de cuotas; se genera un recibo separado por cada operacion.
2. Abrir el credito en Recaudos y seleccionar **Abono extraordinario a capital**.
3. Esperar la verificacion del formulario. Si indica amortizacion original,
   basta ingresar el importe adicional y confirmar que los pagos ordinarios
   correspondientes estan registrados. Si pide conciliacion documentada,
   confirmar el capital pendiente, la tasa por periodo en decimal, la cuota
   capital/interes, el aval y el seguro por cuota, junto con la fuente.
   No usar un saldo proporcional estimado como si fuese capital documentado.
4. Ingresar el importe adicional y solicitar la previsualizacion. Verificar
   capital anterior/posterior, calendario, cuota final y cuotas eliminadas.
5. Confirmar expresamente. Si otro pago cambia el credito entre ambas acciones,
   el servidor exige una nueva previsualizacion. Un reintento identico devuelve
   el mismo recibo; no crea un segundo pago.

### Fuente automatica y controles

- Solo el servidor decide el modo. Vuelve a leer y verificar las fuentes bajo
  el bloqueo del credito en la previsualizacion y en la confirmacion.
- Usa la tasa historica almacenada y el saldo de la amortizacion correspondiente
  a las cuotas ordinarias ya pagadas; no la configuracion financiera vigente.
- Conserva el cobro pactado. En ARES V2 el componente capital/interes es la cuota
  cobrable menos aval y seguro, sin reincorporar el descuento comercial.
- La fuente y sus identificadores quedan incluidos en la conciliacion auditada;
  el hash de la previsualizacion vincula tambien la amortizacion original.
- Si faltan filas o hay diferencias en capital, importes o calendario, se explica
  por que hace falta conciliacion manual. No se ocultan esos campos por el solo
  hecho de que el credito no tenga una marca de importacion.
- Un error al consultar el contexto bloquea la previsualizacion y permite
  reintentar la consulta. No registra pagos al abrir el formulario.
- No se modifican contratos, amortizaciones originales ni creditos existentes
  al habilitar esta automatizacion. Solo una confirmacion expresa registra pago.

Se bloquean abonos con cuotas vencidas, credito cerrado/anulado o un pago Wompi
pendiente. No se acepta un extraordinario igual o superior al capital pendiente:
la liquidacion total usa el flujo de cierre descrito debajo. Tampoco se amplian
plazos ni se inventa el desglose de pagos historicos desconocidos.
Una conciliacion no puede declarar mas capital que la deuda total pendiente,
ni aumentar la obligacion total como consecuencia de recibir el extraordinario.

Si la siguiente cuota tiene un abono parcial, se conserva como pago previo solo
cuando cabe en el nuevo interes. De otro modo se pide completar esa cuota o
conciliarla, sin aplicar el mismo dinero dos veces.

## Caso de aceptacion anonimizado

El caso completo aportado permite comparar todas las cuotas futuras, no solo el
saldo o la ultima cuota. No hay datos identificadores del cliente en las pruebas.

| Concepto | COP |
| --- | ---: |
| Capital original | 3.500.000 |
| Capital antes del pago ordinario de 300.000 | 3.461.494 |
| Capital incluido en ese pago ordinario | 114.230 |
| Capital conciliado antes del extraordinario | 3.347.264 |
| Extraordinario, 100 % a capital | 700.000 |
| Capital despues | 2.647.264 |
| Cuota habitual | 149.700 |
| Cuota capital/interes | 94.470 |
| Aval por cuota subsistente | 54.180 |
| Seguro por cuota subsistente | 1.050 |

Para reproducir el documento se usa tasa periodica **0,010881** y redondeo de
interes al peso en **cada periodo**. Es un parametro de conciliacion del caso,
no una afirmacion sobre la tasa global de ARES. Los importes historicos pagados
no se recalculan con esta tasa.

Quedan 34 cuotas pendientes (4 a 37). La cuota 37, del 17/03/2028, es **112.799**:
capital 56.949 + interes 620 + aval 54.180 + seguro 1.050. Las cuotas 38 a 48
quedan eliminadas y en cero; no se cuentan como pagadas.

Los pagos ordinarios acumulados suman 450.000, frente a 449.100 de tres cuotas:
se conservan **900** abonados en la siguiente cuota por imputacion FIFO a interes.
Asi, la cuota 4 tiene 149.700 programados y 148.800 pendientes. Es una imputacion
derivada de los importes agregados, no una fila de pago individual observada en
el PDF. El capital extraordinario de 700.000 no se vuelve a imputar a cuotas.
El futuro programado suma 5.052.899 y su saldo pendiente es **5.051.999**.

## Persistencia y consumidores

- `Credito.planCapitalVigente` conserva un calendario versionado, sus componentes,
  los pagos incluidos al corte y el capital documentado.
- `CreditPrincipalPaymentRevision` es una bitacora inmutable. Guarda antes/despues,
  conciliacion, actor, recibo, huellas y respuesta idempotente.
- El recibo, el ingreso a caja, el calendario y la revision se escriben en la
  misma transaccion bajo bloqueo del credito. Fallar en uno revierte todo.
- Se conservan `plazoMeses`, contrato y amortizacion originales. `montoCredito`
  representa efectivo acumulado mas saldo exigible revisado, para mantener la
  identidad saldo = montoCredito - recaudos en consumidores agregados. No debe
  usarse ese campo como sustituto del total contractual original firmado.
- Plan de pagos, recaudos, portal del cliente, Wompi, Efecty, mora, desbloqueo,
  cartera y exportaciones usan la revision vigente.
- Las cuotas eliminadas no generan cargos ni aparecen como cuotas pagadas.
  Los recibos historicos sin un desglose fiable no reconstruyen capital ficticio.
- Tras una revision se bloquean anulacion/eliminacion de recaudos y modificaciones
  administrativas del calendario. Requieren una reversa financiera auditada,
  que no forma parte de esta entrega.
- La liquidacion anticipada del plan revisado usa el capital pendiente auditado,
  nunca una proporcion del monto original ni la tasa global actual.

## Liquidacion total desde el portal de clientes

- Se ofrece cuando el plan vigente esta al dia y mantiene capital pendiente.
  Un plan invalido, una cuota en mora o un credito finalizado bloquean la accion.
- El importe es la suma del capital pendiente de las cuotas vigentes, considerando
  los pagos posteriores al corte. El abono extraordinario previo ya esta
  descontado y no se vuelve a aplicar como pago de cuotas.
- Se condonan los componentes futuros restantes del plan (interes, aval y seguro).
  Se conserva el criterio existente de reconocimiento de ingresos ya recaudados.
- La solicitud Nequi/Wompi guarda la revision y el recaudo acumulado junto con
  capital, saldo exigible y condonacion. Se verifican de nuevo bajo bloqueo al
  crear la solicitud y al aplicar la aprobacion. Una cotizacion desactualizada
  requiere revision; no aplica automaticamente al nuevo plan.
- Mientras la intencion esta en creacion, pendiente o aprobada sin aplicar, no
  se permiten nuevas revisiones de capital. El envio no cierra el credito.
- Solo la aprobacion real registra abono y caja, fija el monto exigible en el
  efectivo total recaudado y emite paz y salvo en la misma transaccion. Conserva
  calendario, contratos y bitacora originales; las cuotas eliminadas siguen asi.
- Las lecturas del credito finalizado usan el indicador de paz y salvo: saldo y
  capital pendientes cero, sin volver a ofrecer una segunda liquidacion.

## Verificacion y publicacion

Ejecutar `npm run test:capital`. Pruebas principales:
`tests/credit-principal-payment*.test.mjs`. La referencia
financiera comprueba cada fila 4 a 37, filas eliminadas, segunda operacion,
pagos posteriores, concurrencia, reintentos y restricciones de acceso.
La prueba PostgreSQL nativa usa una base efimera aislada, nunca datos reales.
Es opt-in: `CAPITAL_NATIVE_PG_TEST=1`; permite configurar la carpeta de binarios
con `CAPITAL_NATIVE_PG_BIN`. No lee `DATABASE_URL`.

`scripts/railway-predeploy.mjs` instala de forma idempotente el nuevo campo y la
bitacora antes de arrancar el codigo. No ejecutar una migracion manual sobre
produccion para probar. Primero compilar y validar; publicar solo con autorizacion.
