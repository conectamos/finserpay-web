# Cuota pactada ARES para nuevas originaciones

## Referencia confirmada por el administrador

El amortizador IPADLOCK suministrado el 14 de septiembre de 2026 define capital
como venta menos inicial, aval vencido del 75% sobre capital repartido entre las
cuotas y seguro por cuota `(capital * 0.6 / 1000) / 2`, equivalente a 0.03%.
La línea suministrada usa 29.24% E.A., periodo de 15 días y piso a múltiplos de
COP 50. La tasa periódica se redondea a seis decimales según los ejemplos ARES
comprobados; el JSON exportado por sí solo no define la implementación interna
del indicador `amortizar: true`.

| Venta | Inicial | Cuotas quincenales | Cuota pactada |
| ---: | ---: | ---: | ---: |
| 2.600.000 | 780.000 | 40 | 90.850 |
| 2.600.000 | 780.000 | 48 | 77.700 |
| 1.980.000 | 594.000 | 48 | 59.150 |

Los ejemplos de 48 cuotas sirven para comprobar la matemática y el simulador.
No habilitan cuotas por debajo de COP 90.000 en la fábrica iPhone.

## Contrato de cálculo

`ARES_FRANCES_V2` distingue `cuotaTotal` (referencia matemática), `cuotaCobro`
(cuota pactada), `montoTotalExacto`, `descuentoRedondeo` y `montoTotal` cobrable.
El total cobrable es cuota pactada por número de cuotas. La diferencia de
redondeo se registra como descuento, no como saldo que se recupere al final.
Los componentes exactos se conservan para auditar y conciliar ese descuento.
No se permite que el total cobrable resulte inferior al capital financiado.

La cuota cobrada y el total se persisten coherentemente en el crédito, sus
cuotas y el sello de financiación. Muro y portal cliente consumen estos valores,
sin recalcular a partir de una configuración vigente distinta.

`FRANCES_V1` y `ARES_FRANCES_V1` no cambian. El motor sin versión explícita
conserva V1. Un sello ya firmado o un proceso de firma activo conserva sus
condiciones, incluso si su tasa es 29.66%. Los PDF históricos no se sustituyen.

## Políticas, consultas y activación

El código por sí solo no migra políticas existentes. Antes de habilitar nuevas
originaciones se necesita una activación coordinada del código y de las políticas:

1. Revisar el diff contra la rama vigente de GitHub y confirmar autorización de publicación.
2. Ejecutar `upgradeAresCommercialPolicies` de
   `scripts/ares-commercial-policy-upgrade.mjs` con un cliente PostgreSQL dedicado
   y `actorUserId` del administrador que autoriza. El modo predeterminado es
   **dry run**, que termina en ROLLBACK.
3. Revisar `report.skipped` y el estado de GLOBAL. Perfiles custom, inválidos o con
   fianza/seguro diferentes no se modifican silenciosamente. Resolverlos antes
   de declarar que todos los aliados usan la referencia ARES.
4. Coordinar una ventana de activación: el código antiguo no entiende V2 y el
   código nuevo bloquea nuevas firmas con condiciones antiguas. No ejecutar
   estas dos partes como publicaciones independientes sin ese control operativo.
5. Con aprobación, ejecutar con `dryRun: false`. Se agregan revisiones inmutables
   para perfiles activos o asignados, preservando bandas, topes, mora y demás
   reglas; GLOBAL compatible se actualiza en la misma transacción.
6. Verificar el ejemplo de 40 cuotas en simulador, fábrica, contrato, muro y app.

El script no está conectado al predeploy y no se ejecuta al importarlo. Es
idempotente; el actor es obligatorio. La aplicación exige una actualización
completa por defecto: si alguna política o GLOBAL no son compatibles, se
revierte toda la transacción. No reescribe consultas, créditos, firmas
ni calendarios anteriores. Hay pruebas con PostgreSQL/WASM aislado de triggers,
espejo, inmutabilidad, rollback e idempotencia. La prueba nativa multicliente
con PostgreSQL 18.3 verifica el bloqueo EXCLUSIVE frente a ediciones de políticas
y asignaciones concurrentes, sin impedir las lecturas normales.

Una oferta antigua sin firma recibe `DATACREDITO_FINANCIAL_TERMS_OUTDATED`.
El botón de renovación solicita `reuseOnly: true` y `refreshFinancialTerms: true`,
con consentimiento e identidad verificados. Reutiliza los datos de la consulta
vigente durante sus 15 días originales y evalúa la política actual. No reserva
una consulta pagada ni contacta al proveedor si la caché venció; tampoco borra
el equipo, la inicial ni la validación facial del borrador por ese error.

## Verificación local

`npm run test:ares` incluye casos de referencia, calendario/muro, sellos,
compatibilidad V1, servidores, políticas, editor administrativo y PDF.
Las suites existentes de DataCrédito, FirmaSeguro, cierre, amortización y pagos
se ejecutan adicionalmente. Las muestras PDF usan datos ficticios en `tmp/pdfs`.
Los cambios de interfaz respetan los componentes y tokens existentes; los
detalles matemáticos internos siguen restringidos al administrador central.

Verificación de esta implementación (14-09-2026): build de producción completo,
50/50 pruebas ARES, 65/65 cierre, 33/33 FirmaSeguro, 22/22 amortización,
19/19 pagos y 299 aprobaciones aprobadas con 11 pruebas PostgreSQL omitidas por
ausencia de una base aislada configurada. DataCrédito: 208 aprobadas y 2 omitidas.
El test PostgreSQL/WASM específico del activador ARES sí se ejecutó y pasó.
Se renderizaron e inspeccionaron las páginas modificadas de ambos PDF.

Permanece un fallo previo en `tests/solicitudes-canonical.test.mjs`, prueba de
seguimiento de errores del proveedor: espera tres apariciones de
`errorCode: trackedErrorCode`, pero el código base contiene cinco. Se adaptó
solo el delimitador al nuevo guard de recuperación, sin debilitar esa aserción.
Este documento no acredita un despliegue: comprobar el commit activo en Railway
y el reporte de activación antes de anunciar el cambio en producción.
