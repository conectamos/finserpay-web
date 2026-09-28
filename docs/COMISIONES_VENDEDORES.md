# Comisiones de vendedores

Integrado sobre el dashboard publicado de `conectamos/finserpay-web`, base
`44cd344de5dc4e6bb90ca28a985d6d57be2d6211`. La tarjeta se añade entre los
indicadores y las acciones rápidas, preservando la navegación y las funciones
actuales. La bandeja central está en `/dashboard/comisiones`.

## Reglas del programa

- Inicio: `2026-10-01T00:00:00-05:00`, zona `America/Bogota`.
- Antes del inicio solo aparece Próximamente; no se consultan saldos y el servidor
  rechaza solicitudes anticipadas.
- Cada periodo es un mes calendario colombiano. Los meses anteriores mantienen
  sus movimientos y saldos identificados por mes.
- Tarifas retroactivas sobre todos los créditos válidos del mes: 0–14 = $0;
  15–20 = $20.000; 21–29 = $25.000; 30 o más = $30.000, sin tope de créditos.
- Solo se contabilizan cierres reales asignados al vendedor, con evidencia de
  finalización y firmas. Se excluyen septiembre, meses anteriores, solicitudes,
  borradores, anulaciones, pruebas y duplicados. Se conserva la procedencia de
  pruebas y la fecha de primera finalización aunque el registro cambie después.
- Disponible = generado menos pagos confirmados y solicitudes reservadas.
  Solicitudes parciales, idempotencia y bloqueo transaccional evitan sobregiros.
- Rechazar libera la reserva y guarda el motivo para revisión central. El vendedor
  recibe un mensaje genérico para impedir que un motivo libre revele datos internos.
- Confirmar un pago exige administrador central y comprobante PDF, PNG o JPEG de
  hasta 5 MB. Archivo privado y descarga restringida a su vendedor o al central.
- Anulaciones posteriores conservan el pago histórico y registran el exceso como
  ajuste pendiente. Disponible nunca negativo; reservas sin respaldo se liberan.

## Habilitación por aliado

A partir del inicio, se calcula con la cartera real el saldo pendiente de créditos
con al menos una cuota vencida dividido entre el saldo pendiente total del aliado.
Es el criterio de salud de cartera del dashboard central: se reutiliza
`buildCreditPaymentPlan`, con el plan de capital vigente, fechas colombianas,
abonos no anulados y paz y salvo. No se usa el conteo de clientes ni el estado
MORA como aproximación; créditos históricos de cartera sí forman parte del
indicador aunque no generen comisiones del programa.

El umbral se compara con importes en centavos, antes de redondear el porcentaje:
7,99 % y 7,999 % habilitan; 8,00 % pausa. Sin saldo de cartera, el indicador es 0.
Pruebas marcadas, duplicados explícitos y créditos cancelados quedan excluidos.

Se evalúan las asignaciones activas del vendedor y los aliados de origen que
respaldan periodos con comisión sin pagar. Un cambio de sede no elimina la
condición de un saldo ya ganado. Si cualquiera de esas bolsas está en pausa,
se bloquean nuevas solicitudes del vendedor. Las comisiones siguen creciendo y
las reservas existentes se conservan. El central puede registrar una consignación
ya realizada adjuntando su comprobante.

La comprobación ocurre dentro de la transacción del cobro, después del recálculo,
y al consultar el dashboard. El vendedor solo recibe `payoutsPaused`; ni el motivo,
ni el porcentaje ni la cartera se incluyen en sus respuestas. El panel muestra
la mascota triste y el mensaje aprobado. El estado se refresca al volver a la
pestaña y cada 60 segundos; cada intento de cobro revalida inmediatamente.

## Instalación

La migración aditiva está en `scripts/setup-commissions.sql`. El instalador es
explícito: no se ejecuta durante HTTP ni altera el predeploy actual. Con el entorno
objetivo y su `DATABASE_URL` configurados, aplicar antes de publicar:

```sh
npm run db:setup-commissions
```

Agrega tablas de periodos, solicitudes, pagos, fuentes y auditoría. El trigger de
créditos registra cambios futuros y los coordina con las transacciones de cobro;
no altera importes, clientes ni pagos existentes. Auditoría y pagos confirmados
son inmutables. No ejecutar `prisma db push` para instalar estas tablas auxiliares.
Instalar antes del 1 de octubre permite capturar la primera finalización desde
el inicio. No se necesita activar la pantalla manualmente.

## Validación

```sh
npm run test:commissions
npm run build
```

Las pruebas de persistencia usan SQL real en bases aisladas. Los escenarios
futuros de interfaz usan respuestas de prueba solo en el navegador local;
no existe un parámetro público para adelantar el reloj ni cifras fijas en la
aplicación. Resultados y límites en `docs/COMISIONES_VERIFICACION.md`.
