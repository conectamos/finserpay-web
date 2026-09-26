# Abono a capital: reproduccion local del caso ARES

Estado: **referencia offline, no habilitada para recaudo**. No cambia contratos,
politicas, amortizaciones firmadas, pagos, caja ni datos de clientes. El caso
esta anonimizado y no requiere conexion a base de datos.

## Recibo recibido como evidencia

| Aplicacion del recibo | COP |
| --- | ---: |
| Capital de cuota ordinaria | 5.440 |
| Aval Afianzamos | 5.597 |
| Extraordinario «EXTRA BAJAR-TIEMPO» | 488.963 |
| Total efectivo recibido | 500.000 |

Capital anterior 2.259.514 menos capital ordinario 5.440 menos extraordinario
488.963 = **capital posterior 1.765.111**. La reduccion de capital es 494.403,
no 500.000. El recibo no tiene un nuevo cobro de intereses ni de mora.

El plan historico muestra ademas 5.440 de intereses ya pagados en la cuota 4.
Ese dato se conserva separado como `priorInterestPaid`: no es otro pago,
no se resta otra vez del principal y no cambia la clasificacion del recibo.
Los dos recibos del mismo dia concilian de forma agregada:

- Capital: 494.403 + 66.787 = 488.963 + 72.227 = 561.190.
- Interes: 30.752 = 25.312 + 5.440.

## Reconstruccion del calendario futuro

Parametros explicitos que reproducen los importes visibles:

- Capital ya conciliado: 1.765.111.
- Tasa periodica de referencia: 0,010881. Inferida para comparar este caso;
  no es prueba de la configuracion interna de ARES ni la tasa de los creditos nuevos.
- Cuota de capital e interes: 97.539.
- Aval fijo por cuota subsistente: 60.061; seguro fijo: 900.
- Calendario restante proporcionado: cuotas 4 a 37, dias 2 y 17.
- Reconstruccion francesa sin redondeo intermedio y presentacion al peso mas
  cercano. Las capturas no demuestran la precision interna de ARES.

| Cuota | Fecha | Capital mostrado | Interes mostrado | Total | Pendiente |
| ---: | --- | ---: | ---: | ---: | ---: |
| 4 | 2026-10-02 | 78.333 | 19.206 | 158.500 | 153.060 |
| 5 | 2026-10-17 | 79.185 | 18.354 | 158.500 | 158.500 |
| 6 | 2026-11-02 | 80.047 | 17.492 | 158.500 | 158.500 |
| 7 | 2026-11-17 | 80.918 | 16.621 | 158.500 | 158.500 |
| 8 | 2026-12-02 | 81.798 | 15.741 | 158.500 | 158.500 |
| 24 | 2027-08-02 | 25.431 | 277 | 86.669 | 86.669 |

Quedan **21 cuotas**, desde la 4 hasta la 24. La ultima cuota calculada antes
de presentarla al peso es 86.668,531658. Las cuotas 25 a 32 aparecen en cero en
las capturas; las 33 a 37 tambien resultan en cero en la proyeccion, pero no
fueron mostradas. Las otras filas intermedias son calculadas, no observadas.

## Ejecutar la comparacion

```sh
node scripts/reproduce-ares-capital-reference.mjs
node --test tests/ares-capital-reference.test.mjs
```

El modulo en `scripts/lib/ares-capital-reference.mjs` exige la distribucion
explicita del recibo y un calendario ordenado. Rechaza recibos que no concilien,
capital negativo, amortizacion negativa, pagos previos incompatibles y plazos
insuficientes. No prolonga el plazo ni decide como repartir un pago nuevo.

## Alcance de esta referencia

Este script conserva la primera comparacion exploratoria. **No es el motor de
recaudos**. El segundo plan completo permite distinguir el redondeo por periodo:
el motor integrado redondea el interes al peso en cada cuota, en lugar de hacerlo
solo al presentar los resultados. Consulta `ABONOS_CAPITAL.md` para la operacion,
la conciliacion inicial y la prueba integral del plan actualizado.

La coincidencia de este caso no define prioridad general de imputacion,
devengo entre vencimientos, tratamiento contractual general de aval y seguro
futuros, ni asignacion del descuento comercial de ARES V2 por componente.
No se cambia ni calcula la mora.

Una integracion debe partir de componentes y saldos conciliados, conservar el
contrato y la amortizacion original y registrar una revision auditable del
calendario. Caja debe conservar todo el efectivo recibido, mientras el
extraordinario no debe aplicarse de nuevo como un adelanto FIFO de cuotas.
Cliente, recaudos, pasarelas, reportes y liquidaciones deben consumir el mismo
calendario vigente; editar/anular movimientos no puede invalidarlo silenciosamente.
No se usa la estimacion proporcional de la liquidacion anticipada actual como
si fuera el capital real. Los historicos sin desglose fiable requieren conciliacion.
