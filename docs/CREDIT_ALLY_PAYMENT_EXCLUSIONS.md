# Exclusión administrativa de liquidaciones a aliados

Un crédito se excluye únicamente cuando existe una fila para su ID en
`CreditAllyPaymentExclusion`. No se excluyen automáticamente todos los créditos
importados. La exclusión operativa no cambia el contrato ni las reglas de
aprobación, los importes o el calendario del cliente.

La exclusión impide incluir el crédito y sus recaudos en pendientes, vistas
previas y nuevas liquidaciones a aliados. No modifica liquidaciones anteriores.
Registrar una exclusión para un crédito o recaudo ya liquidado produce
`ALLY_PAYMENT_CREDIT_ALREADY_SETTLED`.

La tabla conserva motivo, nombre y SHA-256 del archivo, hoja, fila, responsable
administrativo y fecha UTC. Sus registros son inmutables. No existe una acción
de interfaz que permita eliminarlos; cualquier cambio de esta decisión necesita
un proceso administrativo explícito con su propia auditoría.

## Instalación y uso

El predeploy existente `scripts/ensure-ally-payments-schema.mjs` instala y valida
la tabla. El módulo de pagos inicializa el mismo esquema antes de consultar.
Ambos utilizan los SQL compartidos de
`scripts/credit-ally-payment-exclusion-schema.mjs`.

Una carga administrativa debe registrar la exclusión y reasignar aliado/sede/
vendedor dentro de la misma transacción, con la fila de `Credito` bloqueada.
No puede utilizar una liquidación ficticia para representar la exclusión.

Los triggers en `LiquidacionAliadoCredito` y `LiquidacionAliadoRecaudo`
rechazan un crédito excluido incluso si la llamada usa una vista previa antigua
o intenta insertar directamente en la base. El recaudo se verifica también
contra el crédito real de `CreditoAbono`.

## Verificación

`npm run test:pagos-aliados` incluye las pruebas existentes y
`tests/ally-payment-exclusion.test.mjs`. Para ejecutar el caso de SQL y triggers
en PostgreSQL en memoria, instalar `@electric-sql/pglite` en un directorio de
pruebas externo y asignar `ALLY_PAYMENT_PGLITE_MODULE` a su
`dist/index.js`. El caso usa únicamente datos sintéticos y una base en memoria;
no requiere conexión a producción. Si la variable no está configurada, se omite
ese caso y se informa en el resultado.

Las pruebas verifican: exclusión puntual, conservación de otros importados,
alcance de aliado/período, consultas de pendientes y bloqueadas, recaudos,
inserciones directas, IDs de recaudo falsificados, historial ya liquidado,
inmutabilidad y conservación del snapshot contractual.

