# Riesgo por referencia

Ruta: `/dashboard/riesgo-referencia`, disponible exclusivamente para el administrador central FINSER.

Los filtros de fechas corresponden a la fecha de venta en Colombia. El saldo y la mora corresponden al corte actual, no a una reconstrucción histórica. Todos los filtros se aplican a tarjetas, tabla, gráficas y detalle.

Cada crédito elegible representa una unidad financiada. El porcentaje es `unidades en mora / unidades financiadas * 100`, incluyendo créditos pagados en el denominador. Las unidades activas tienen saldo positivo. Las unidades en mora tienen saldo positivo y cuotas vencidas pendientes. El promedio de días considera únicamente las unidades en mora. El porcentaje general usa los totales de unidades, no el promedio de porcentajes de las referencias.

El saldo y valor vencido reutilizan `buildCreditPaymentPlan`, excluyendo abonos anulados y respetando el paz y salvo, el plan vigente tras abonos a capital y la fecha administrativa del próximo pago. El capital reutiliza `resolveCapitalOriginal`. Las referencias se agrupan por marca, modelo y plataforma, sin distinguir mayúsculas.

## Evidencia de financiación

El esquema actual no tiene fecha ni bandera explícita de desembolso. Como criterio conservador, se incluyen créditos con paz y salvo o con contrato y pagaré aceptados y evidencia de entrega/remisión o un estado ENTREGADO, FINALIZADO, DESEMBOLSADO o PAGADO. ENTREGABLE indica preparación del dispositivo y no basta por sí solo. Siempre se excluyen estados anulados, cancelados, rechazados, pendientes o no desembolsados y montos no positivos.

La cartera histórica se incluye cuando los dos marcadores persistidos, `equalityService` y `contratoSnapshot.origen.tipo`, identifican `IMPORTACION_MASIVA`; estos créditos ya originados se importan sin firmas ni fotografías. Las exclusiones por estado se aplican antes de esta evidencia. Si se incorpora una fuente explícita de desembolso, debe reemplazar este criterio en `riskCreditEligible` y acompañarse de pruebas. Las fotografías y los contratos completos no se envían al navegador; la consulta proyecta únicamente la existencia de evidencia, la plataforma y el origen.

## Gestión de cartera

El detalle muestra la última gestión de `CreditMoraManagementEvent` según `createdAt DESC, id DESC`, con su acción, resultado, comentario y fecha de actuación. Si no existe, muestra «Sin gestión registrada». El número de crédito usa el número SADMIN confirmado cuando existe, con el folio como respaldo.

## Verificación

`node --experimental-strip-types --test tests/product-risk.test.mjs`

Las pruebas cubren fórmula, denominador con pagados, valores acumulados, promedio, límites de riesgo, elegibilidad, filtros combinados, agrupación y detalle.
