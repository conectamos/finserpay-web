# Rediseño de Cartera por referencias visuales

Las vistas de Riesgo por referencia y Detalle de mora usan resumen horizontal, tabla única, pestañas, búsqueda, filtros desplegables, ordenamiento y paginación, con componentes y tokens FINSER PAY. La tabla se desplaza horizontalmente en móvil. La navegación grafito, la marca blanca/verde y el acento lima conservan la identidad aprobada.

Riesgo mantiene las consultas y la elegibilidad productivas, incluidas importaciones históricas, numeración visible y fuente de gestiones de mora. Los totales usan créditos, no promedios de referencias, y funcionan también con el DTO aliado sin saldos. La tabla aliada tiene Referencia, Financiados, En mora, % mora y Detalle; central agrega Saldo vencido. El texto libre de gestión se conserva solo en la proyección central porque puede contener importes vencidos.

Detalle de mora consume los mismos DTO y agregación actuales de Salud de cartera. No altera cálculos, identificación de vendedores, reglas de asignación, scopes ni exportaciones del servidor. Saldo pendiente en mora es el saldo completo de créditos en mora; Participación indica su proporción del total en mora; Aporte a cartera conserva la contribución vigente expresada en pp. Los filtros y búsqueda de grupos delimitan la tabla, mientras el resumen conserva la cartera del aliado consultado. Los enlaces de créditos mantienen el alcance validado en servidor.

Pruebas de interfaz y permisos cubren ambos roles, resumen, agrupación, filtros sin importes, detalle, exportaciones, paginación, ordenamiento, cero de mora e importaciones históricas. Las pruebas existentes de cálculo y scopes se conservan; las pruebas de distribución se adaptan a la nueva tabla única.
