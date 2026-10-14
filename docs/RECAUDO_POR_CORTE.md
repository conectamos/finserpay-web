# Recaudo por corte

Disponible en **Cartera → Recaudo por corte**, inmediatamente debajo de
**Riesgo por referencia**, para administradores. Los supervisores tienen acceso
al módulo en Cartera según su sede. También figura en el centro de reportes.
Ruta: `/dashboard/reportes/recaudo-por-corte`.

## Uso

1. Seleccionar corte 02 o 17, mes, año, aliado y sede. La fecha inicial es el
   siguiente corte según `America/Bogota`.
2. Consultar la vista previa y guardar la proyección. Se capturan todas las
   cuotas del corte dentro del aliado/sede seleccionados, independientemente
   del filtro de estado. El servidor fija la fecha y hora del guardado.
3. Consultar esa versión para medir pagos posteriores, incluso después del
   vencimiento. Preparar una nueva proyección crea otra versión; no sustituye
   la anterior. El historial permite comparar cortes y versiones, en páginas
   de diez registros; las versiones anteriores siguen disponibles.
4. Aplicar estado para filtrar simultáneamente tabla, tarjetas y exportación.
   El Excel incluye resumen, cuotas, pagos aplicados y la página del histórico
   consultada, identificada expresamente en el resumen del archivo.

## Fuente y distribución

La fuente de efectivo es únicamente `CreditoAbono`. Caja, intenciones Wompi e
importaciones Efecty no se suman adicionalmente: representan los mismos abonos.
La autorización se aplica a la sede **del crédito**, también para recaudos
digitales recibidos en una sede recaudadora diferente.

La plataforma no mantiene una tabla persistida de distribución pago→cuota.
`buildCreditPaymentPlan` aplica la suma de abonos vigentes en orden de cuota.
Este reporte reutiliza ese cronograma y reconstruye la asignación de cada
abono en el orden del recibo oficial (`fechaAbono`, luego ID). Los IDs guardados
determinan si el pago es previo o nuevo: una importación con fecha antigua
no se convierte en un anticipo que existía al proyectar. Si entra antes de otros
pagos en ese orden, puede reasignar los anticipos existentes; esa variación se
presenta como ajuste, sin atribuir a ese abono cuotas distintas de las del recibo.
Se registran todos los IDs conocidos al guardar, incluidos los anulados.

Cada versión guarda el cronograma completo de los créditos incluidos, los
abonos conocidos y los valores calculados de cada cuota: vencimiento, valor,
anticipos, saldo esperado y distribución inicial. Los importes originales se
leen directamente de la versión; no se recalculan para construir el esperado.
Se incluyen únicamente cuotas cuyo vencimiento guardado coincide exactamente
con la fecha seleccionada; las cuotas eliminadas no forman parte de la cohorte.

- **Esperado:** saldo pendiente persistido al guardar.
- **Anticipos previos:** efectivo ya asignado a esas cuotas al guardar.
- **Recibido:** asignación vigente de abonos cuyos IDs no estaban en la versión.
  Los abonos anulados, reversados, revertidos o eliminados dejan de contar.
- **Ajuste de anticipos:** anticipos guardados menos la asignación actual de
  los IDs previos. Puede ser negativo si se rehabilita un pago previo.
- **Pendiente por cuota:** `máximo(0, esperado − recibido + ajuste de anticipos)`.
- **Cumplimiento:** `recibido / esperado × 100`; si esperado es cero, **No aplica**.
  No se limita a 100%: recuperar anticipos revertidos puede superar lo proyectado.
- **Clientes pendientes:** documentos distintos con saldo pendiente; cuando
  falta el documento se conserva una identidad por crédito.

Recuperación de cuotas anteriores y anticipos de cuotas futuras se muestran
fuera del cumplimiento. Su alcance son los créditos de las filas visibles;
no representan todos los pagos diarios de la empresa. Se deduplican por crédito.
Las tarjetas suman exactamente las mismas filas que la tabla y el Excel.

## Ajustes de crédito

El cierre o paz y salvo no se transforma en dinero recibido. Una condonación,
anulación o modificación del calendario conserva el esperado histórico y genera
una observación. Cuando el calendario ordinario cambia, se compara el efectivo
aplicado a los mismos números de cuota y se mantiene la fecha guardada.

Los planes conciliados por abono a capital usan `planCapitalVigente`, validando
los IDs y valores de sus abonos base. Los anticipos agregados de esa conciliación
incluyen acceso a los abonos fuente y una advertencia: no existe asignación
individual por cuota para esas fuentes y no se inventa esa distribución.
Si se altera esa conciliación o cambia la
revisión de capital después de proyectar, la plataforma no dispone de un ledger
histórico que permita asignar el efectivo con certeza. Se solicita conciliación
con un error explícito; no se inventan importes. La versión permanece visible
en el historial con valores actuales desconocidos, sin presentarlos como cero.

## Persistencia y permisos

`CutCollectionProjection` es una tabla independiente y de solo inserción.
Un trigger impide UPDATE/DELETE. El guardado y la consulta leen cronogramas y
pagos en una transacción `REPEATABLE READ`. La única escritura del módulo es el
INSERT de la versión; no actualiza créditos, abonos ni saldos. Una clave UUID
por intento evita crear una segunda versión al reintentar el mismo guardado.

- Administrador central: todas las sedes autorizadas.
- Administrador de aliado: sedes de su aliado de acceso.
- Supervisor: su sede operativa autorizada.
- Vendedores y sesiones ausentes: acceso denegado.

El servidor valida los filtros y vuelve a restringir el historial por sede
guardada y sede actual del crédito. Un traslado a un alcance no autorizado no
expone datos del cliente. Los cambios de alcance se indican en pantalla.
Los timestamps se almacenan como instantes y se presentan en Colombia; los
vencimientos conservan su fecha calendario original.

## Instalación y verificación

El predeploy ejecuta `scripts/ensure-cut-collection-schema.mjs`, que instala
`scripts/setup-cut-collection.sql`. También puede ejecutarse explícitamente con
`npm run db:setup-cut-collection` con `DATABASE_URL` configurada. Importar o
consultar el módulo no instala ni modifica el esquema. Si falta la tabla,
la vista previa sigue disponible con aviso y guardar requiere la instalación.

Pruebas: `npm run test:cut-collection`. Cubren asignación, anticipos, pagos
parciales/tardíos, reversos, fecha histórica de importación, cero esperado,
inmutabilidad, conciliación de capital, permisos, aislamiento de sedes,
idempotencia, lectura sin efectos en créditos/pagos, HTTP y Excel.

API: GET y POST `/api/reportes/recaudo-por-corte`; GET acepta `format=xlsx` y
`projectionId`. POST recibe filtros y `requestKey` UUID. Las respuestas son
privadas y no se almacenan en caché. Guardar requiere mismo origen y JSON.
