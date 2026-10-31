# Saldos de comisiones por asesor

La consulta central está en `/dashboard/comisiones/saldos`, accesible desde
Comisiones mediante **Saldos por asesor**. Muestra comisiones por asesor y mes,
incluyendo asesores que nunca han solicitado cobro ni abierto Mis comisiones.
Los asesores inactivos con actividad, historial o saldo también permanecen en la
consulta; su indicador Inactivo no habilita nuevos cobros.

Esta pantalla complementa la bandeja de `/dashboard/comisiones`, que muestra
solicitudes de cobro. **En trámite: 0** en esa bandeja significa que no hay
solicitudes pendientes; no demuestra que todos los asesores hayan cobrado.

Las [reglas vigentes del programa](COMISIONES_VENDEDORES.md), sus tarifas,
permisos, comprobantes y flujos de solicitud, rechazo y pago se conservan.

## Filtros y lectura de la tabla

- **Todos los pendientes** es el filtro inicial. Incluye los meses con importe
  pendiente de pago, reservas en trámite o ajustes que requieren revisión.
- **Mes** consulta la actividad y el historial de ese mes. Los meses se calculan
  en `America/Bogota`, desde octubre de 2026 hasta el mes actual. El selector
  incluye siempre el mes actual, aunque aún no tenga ventas ni filas.
- **Buscar asesor o sede** filtra por nombres reales del asesor y de las sedes
  de origen vinculadas a los créditos o al historial del período.
- Cada fila corresponde a un asesor y un mes. Un asesor puede tener varias
  filas; el contador de asesores cuenta personas distintas.
- La paginación muestra hasta 40 filas. Los totales corresponden a todas las
  filas que coinciden con los filtros, antes de paginar.

La pantalla se actualiza con **Actualizar saldos**, al volver a la ventana y
cada 60 segundos mientras está visible. La fecha del servidor identifica el
instante de la consulta. Un error de acceso retira los importes mostrados.

## Importes del informe

Todos los importes se expresan en pesos colombianos enteros. El cálculo se
realiza por asesor y mes antes de sumar los totales:

| Concepto | Cálculo |
| --- | --- |
| Ventas válidas | Créditos canónicos elegibles finalizados en ese mes |
| Generado | Ventas válidas del mes × tarifa correspondiente a ese mes |
| Pagado | Suma de solicitudes de ese asesor y mes con estado `PAID` |
| En trámite | Suma completa de solicitudes persistidas con estado `PENDING` |
| Sin solicitar | `max(0, generado − pagado − en trámite)` |
| Total pendiente | `max(0, generado − pagado)` |
| Ajuste en revisión | `max(0, pagado + en trámite − generado)` |

**En trámite ya forma parte del total pendiente**; no se suma nuevamente a ese
total. Las solicitudes rechazadas no reservan dinero ni cuentan como pagos.
Un ajuste no se suma a la deuda por pagar ni representa una nueva comisión.

Si una reserva persistida supera el respaldo actual, el informe conserva su
importe real y muestra el ajuste para revisión. Esta consulta no rechaza la
solicitud, no libera su reserva y no modifica registros para hacer coincidir
los importes.

## Cambio de mes y saldos anteriores

Al comenzar un nuevo mes colombiano, el conteo y la tarifa del nuevo período
se calculan desde cero. Los pagos, solicitudes y saldos de los meses anteriores
conservan su mes; no se borran ni se trasladan al conteo del nuevo mes.

Ejemplo de verificación local: octubre con $525.000 generados y $100.000 pagados
conserva $425.000 pendientes cuando comienza noviembre. Noviembre tiene su propio
conteo y debe alcanzar sus propios umbrales para generar comisión.

Los totales suman el pendiente positivo de cada mes. Un sobrepago o ajuste de
octubre no compensa automáticamente una comisión impagada de noviembre. El
historial permanece sujeto a los créditos canónicos y a los movimientos reales;
una anulación puede cambiar el respaldo, sin borrar los pagos confirmados.

## Pausa y revisión

El indicador **En pausa** reutiliza la política actual de salud de cartera:
evalúa las asignaciones activas del asesor y los aliados de origen que respaldan
comisiones todavía impagadas. Cambiar de sede no elimina el origen del saldo.
También se calcula correctamente si el asesor aún no tiene filas materializadas
en `CommissionPeriod` ni solicitudes de cobro.

La pausa informa sobre la habilitación actual del cobro; no resta comisiones,
no elimina reservas y no ejecuta pagos. Las condiciones y el umbral vigentes
están descritos en [Habilitación por aliado](COMISIONES_VENDEDORES.md#habilitación-por-aliado).
Un ajuste se muestra como **Revisión**, separado de los importes pendientes.

## API y garantías de consulta

La página utiliza exclusivamente:

```text
GET /api/admin/comisiones/saldos?period=all_pending&search=&page=1
GET /api/admin/comisiones/saldos?period=2026-10&page=1
```

- `period`: `all_pending` por defecto, o `YYYY-MM` dentro de la vigencia.
- `search`: nombre de asesor o sede, hasta 120 caracteres en la API.
- `page`: entero entre 1 y 10.000; tamaño fijo de 40 filas.
- Parámetros desconocidos, repetidos, meses anteriores al programa y meses
  futuros se rechazan.

La respuesta contiene `currentPeriod`, `serverNow`, `periods`, `rows`, `total`,
`page`, `pageSize` y `totals`. Incluye el identificador del asesor y las sedes
para conservar la vinculación canónica, sin publicar Nequi, datos de clientes,
documentos ni enlaces a comprobantes. El acceso es exclusivo del administrador
central y se revalida en la misma transacción, con usuario, sede y aliado activos.
Las respuestas son privadas y no se almacenan en caché.

El servidor abre una transacción `REPEATABLE READ, READ ONLY` antes de consultar.
Créditos, pagos, reservas y cartera pertenecen a un mismo snapshot. Se reutilizan
la elegibilidad y la deduplicación global del programa; créditos y cartera se
leen en conjunto, sin una consulta de cartera por asesor.

El informe no llama a `syncPeriods`, no materializa períodos, no escribe
auditoría y no toma el bloqueo global exclusivo de los cobros. No requiere
tablas nuevas, migraciones, credenciales ni cambios en integraciones.

La consola anterior de **Solicitudes de cobro** conserva su recálculo operativo
existente. La ruta independiente de saldos no invoca ese endpoint: abrirla permite
consultar el informe sin ejecutar ese recálculo ni sus posibles ajustes de reservas.

## Verificación local

```sh
node --test tests/commissions-balances.test.mjs
node --test --test-concurrency=1 tests/commissions.test.mjs tests/commissions-storage.test.mjs tests/commissions-http.test.mjs tests/commissions-portfolio.test.mjs
```

Las 10 pruebas nuevas usan PostgreSQL embebido y handlers reales con fronteras
de sesión sustituidas: nunca solicitados, inactivos, reservas excesivas sin
modificación, pagos parciales, rechazos, cambio de mes colombiano, ajustes sin
compensación entre meses, deduplicación entre asesores, pausa por origen,
paginación global, permisos y privacidad. Comprueban los ajustes de transacción
y que las tablas financieras no cambian. Las 32 pruebas existentes de reglas,
persistencia, HTTP y cartera también pasan. Son pruebas locales; no ejecutan
pagos ni solicitudes sobre producción.
