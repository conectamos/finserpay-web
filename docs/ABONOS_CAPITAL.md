# Abonos extraordinarios a capital con reduccion de plazo

## Alcance

La operacion esta separada del pago ordinario en Recaudos y solo esta habilitada
para ADMIN de FINSER PAY central. Mantiene la cuota habitual y reduce el plazo;
no adelanta cuotas ni distribuye el extraordinario entre intereses y cargos.
No registra automaticamente los casos de prueba ni modifica contratos firmados.
La implementacion local requiere su publicacion y migracion antes de usarse.

No calcula mora, no cambia tasas generales ni aplica retroactivamente el
29,24 % EA a creditos historicos. La primera operacion exige una conciliacion
documentada del credito; los siguientes abonos usan sus terminos ya guardados.

## Operacion

1. Registrar primero los pagos ordinarios. No sumar el extraordinario al importe
   de cuotas; se genera un recibo separado por cada operacion.
2. Abrir el credito en Recaudos y seleccionar **Abono extraordinario a capital**.
3. En la primera operacion, confirmar el capital pendiente despues de esos pagos,
   la tasa por periodo en decimal, la cuota capital/interes, el aval y el seguro
   por cuota, junto con el documento y la fecha que sustentan esos valores.
   No usar un saldo proporcional estimado como si fuese capital documentado.
4. Ingresar el importe adicional y solicitar la previsualizacion. Verificar
   capital anterior/posterior, calendario, cuota final y cuotas eliminadas.
5. Confirmar expresamente. Si otro pago cambia el credito entre ambas acciones,
   el servidor exige una nueva previsualizacion. Un reintento identico devuelve
   el mismo recibo; no crea un segundo pago.

Se bloquean abonos con cuotas vencidas, credito cerrado/anulado o un pago Wompi
pendiente. No se acepta un extraordinario igual o superior al capital pendiente:
la liquidacion total requiere conciliacion independiente. Tampoco se amplian
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
- La liquidacion anticipada proporcional anterior no se ofrece en estos creditos.
  Se muestra capital real; la liquidacion total necesita un procedimiento conciliado.

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
