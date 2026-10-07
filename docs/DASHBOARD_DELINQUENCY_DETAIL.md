# Detalle de mora en los paneles administrativos

La sección **Cartera → Detalle de mora**, en
`/dashboard/cartera/detalle-mora`, muestra el detalle de su propia cartera al
administrador aliado. Es independiente de Salud de cartera y del panel de inicio. El
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
- Saldo pendiente de esos créditos, únicamente al administrador central.
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

Los saldos en mora no se incluyen en el objeto de datos que recibe la pantalla
del administrador aliado ni en su exportación Excel. Se conservan internamente
para calcular participación, aporte y ranking. El permiso proviene de la sesión;
los parámetros de URL no pueden habilitar importes ni ampliar el aliado consultado.
El administrador central conserva los importes incluso al filtrar por un aliado.

La exportación `.xlsx` contiene Resumen, Sedes y Vendedores. “Ver créditos” abre
el listado en mora del grupo seleccionado dentro de esta misma sección, con
número visible de crédito, cliente, cédula, sede, vendedor y días de mora.
No incluye datos monetarios y rechaza grupos fuera del alcance autorizado.
La fecha de actualización usa Bogotá; no se ofrece un mes histórico para un
cálculo que representa la cartera actual.

Este panel es de consulta. No cambia cuotas, fechas, saldos, responsables ni
decisiones de aprobación.
