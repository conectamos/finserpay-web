# Excepcion de apertura de pagos a aliados — 2026-09-08

Referencia: `ALLY_PAYMENT_20260908_C189`.

El propietario solicito incluir el credito del 31 de agosto desde el 1 de
septiembre y autorizo publicarlo el 8 de septiembre de 2026 en `PAGO ALIADOS`
(`01a06088-55d7-7ad1-9204-cf1150e928e9`).

La consulta de produccion de solo lectura resolvio un unico credito:

- Credito `189`, folio `FC-20260831170410-06B0`.
- Aliado `65588`, JG COMPANY.
- Fecha original almacenada: `2026-08-31 17:08:40.184`, columna
  `timestamp without time zone`, verificada mediante `fechaCredito::text`.
  Se compara como timestamp UTC sin conversion local del controlador.
  El dia del credito sigue siendo el 31 de agosto en Colombia.
- Fecha efectiva de liquidacion: `2026-09-01T05:00:00.000Z`
  (1 de septiembre a las 00:00, Colombia).
- Estado observado: `INSCRITO`, sin liquidacion registrada.

La excepcion es inmutable y exige coincidencia simultanea de credito, aliado
y fecha original exacta. El motivo es pagar esta venta anterior al corte de
apertura del modulo. No modifica filas de Credito, contratos, recaudos ni
liquidaciones historicas. El commit registra la autorizacion y el ajuste.

Pendientes, previsualizacion y registro transaccional comparten la misma
consulta. El periodo usa la fecha efectiva. Pantalla, PDF y snapshots guardados
conservan la fecha original. La huella de previsualizacion incluye la fecha
efectiva. Siguen aplicando los controles de aliado, anulacion, credito ya
liquidado y concurrencia. El hash de solicitudes conserva su version para
mantener la idempotencia de solicitudes registradas antes del despliegue.

No requiere migracion ni backfill. El administrador debe previsualizar y
confirmar el pago con su aprobacion bancaria. Formula y porcentajes mantienen
las reglas vigentes del modulo.

Reversion: revertir este commit y desplegar. Si el credito sigue pendiente,
quedara nuevamente fuera del corte. Si ya fue pagado, su liquidacion permanece
intacta y la unicidad de credito sigue impidiendo un segundo pago.
