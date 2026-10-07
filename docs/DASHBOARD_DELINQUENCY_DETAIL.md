# Detalle de mora en los paneles administrativos

El panel del administrador aliado muestra el detalle de su propia cartera. El
administrador central puede consultar el consolidado o seleccionar un aliado.
El alcance se decide en el servidor usando la sesión; un parámetro de URL no
permite al aliado consultar créditos de otra empresa.

El detalle desglosa la misma mora que presenta **Salud de cartera**. Se cuenta
una vez cada crédito con saldo pendiente y al menos una cuota vencida sin pagar.
El saldo que se distribuye es el saldo pendiente completo de esos créditos,
igual que en Salud de cartera. No se limita al importe de las cuotas vencidas.
Los créditos pagados, con paz y salvo, anulados o cancelados quedan excluidos.
El cálculo representa la cartera actual y no cambia por seleccionar otro mes
para los indicadores de ventas y recaudo.

Para cada sede y vendedor se presentan:

- Cantidad de créditos en mora.
- Saldo pendiente de esos créditos.
- Participación en la mora: saldo del grupo dividido por el saldo total de los
  créditos en mora dentro del alcance seleccionado.
- Aporte a la cartera: saldo del grupo dividido por todo el saldo pendiente de
  la cartera seleccionada.

Por ejemplo, si Salud de cartera muestra 6 % de mora y una sede representa la
mitad del saldo de esa mora, su participación es 50 % y su aporte a la cartera
es de 3 puntos porcentuales. La distribución completa por sede y la distribución
completa por vendedor se consultan por separado: ambas explican la misma mora.
No deben sumarse entre sí.

Los rankings se ordenan por saldo en mora y luego por cantidad de créditos.
Las sedes se identifican por ID; los vendedores y los usuarios históricos usan
identificadores separados. Una importación sin asignación válida aparece como
**Sin vendedor asignado**, conservando su saldo y cantidad en la distribución.
No se atribuye automáticamente la venta al administrador que cargó el lote.
Los porcentajes mostrados se redondean para lectura.

Este panel es de consulta. No cambia cuotas, fechas, saldos, responsables ni
decisiones de aprobación.
