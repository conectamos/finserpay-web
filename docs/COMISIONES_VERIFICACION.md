# Verificación de comisiones — 27 de septiembre de 2026

Integrado sobre la última publicación consultada de `conectamos/finserpay-web`,
`44cd344de5dc4e6bb90ca28a985d6d57be2d6211`. El dashboard actual conserva sus
indicadores, acciones, app de clientes, navegación y créditos recientes.
Este informe registra la validación local previa a la publicación autorizada.

## Pruebas automáticas

`npm run test:commissions`: **37 pruebas aprobadas**: 4 de reglas, 14 de
persistencia, 13 HTTP, 5 de interfaz/permisos centrales y 1 de precisión del
indicador. Persistencia con SQL real y la migración en PostgreSQL embebido PGlite.
Las pruebas HTTP ejecutan los handlers sustituyendo sesión y persistencia.

| Caso | Resultado comprobado |
| --- | --- |
| 30/09/2026 23:59:59.999 Colombia | Próximamente; sin saldos ni cobro; no consulta tablas financieras |
| 01/10/2026 00:00:00 Colombia | Programa activo, periodo octubre |
| 14 / 15 / 16 créditos | $0 / $300.000 / $320.000 |
| 20 / 21 créditos | $400.000 / $525.000 |
| 29 / 30 / 31 créditos | $725.000 / $900.000 / $930.000 |
| Septiembre y anteriores | Excluidos incluso tras actualizar el registro |
| Pendientes, pruebas, duplicados | Excluidos; anular el original no habilita un duplicado |
| Pago parcial y salto 20 → 21 | Generado $525.000, pagado $100.000, disponible $425.000 |
| Cambio a noviembre | Metas en cero; octubre conserva $425.000 disponibles |
| Disponible $100.000, solicitud $50.000 | Reserva $50.000 y conserva $50.000 disponibles |
| Monto superior al saldo | Rechazado en servidor |
| Solicitudes simultáneas e igual clave | Sin sobregiro ni doble reserva |
| Rechazo | Libera reserva y conserva motivo interno auditable |
| Sin comprobante / archivo inválido | Pago rechazado |
| Confirmación repetida / comprobante repetido | Un pago por solicitud y comprobante único |
| Anulación después de pago | Conserva historial, registra ajuste y disponible cero |
| Mora posterior del cliente | No elimina el crédito válido ni la comisión |
| Aliado 7,99 % / 7,999 % | Cobro habilitado, sin redondear el umbral |
| Aliado 8,00 % | Nuevas solicitudes bloqueadas para todos sus vendedores |
| Pausa con créditos nuevos | 15 → 21 créditos, $300.000 → $525.000 conservados |
| Abonos anulados | No reactivan la bolsa |
| Abonos reales / paz y salvo | Recalculan cartera y reactivan al bajar del 8 % |
| Pausa con reserva anterior | Reserva conservada; pago ya consignado registrable |
| Cambio de sede o traslado del crédito | Conserva aliado de origen del saldo pendiente |
| API del vendedor | Solo flag de disponibilidad; sin porcentaje, cartera ni causa interna |
| Motivo libre de rechazo | No filtra información interna al vendedor; central conserva el original |
| Permisos | Vendedor propio; supervisor, aliado y analista sin acceso central |
| Comprobantes | Descarga privada solo por propietario o administrador central |
| Auditoría y pagos | UPDATE y DELETE rechazados; historial inmutable |

La concurrencia se verificó con Promise.all y transacciones PGlite. Su conexión
serializada comprueba restricciones y resultados superpuestos, pero no constituye
una prueba de carga con múltiples conexiones PostgreSQL nativas.

## Compilación y regresión

- `npm run build`: compilación completa y TypeScript aprobados.
- ESLint de módulos nuevos, rutas e integraciones: aprobado.
- Dashboard comercial actual: 4/4 pruebas aprobadas.
- Cartera/aliados: 28/28; Efecty: 20/20; descarga cliente de la publicación más
  reciente: 11/11. Pruebas administrativas de navegación/permisos: 41 aprobadas
  en la ejecución conjunta (incluye las 5 del módulo ya contadas).
- Cierre de créditos: 65/66. Falla preexistente en
  `credit-close-request-binding.test.mjs`: regex limitado a 320 caracteres ante
  un bloque de 417 caracteres. Archivo y código probado idénticos a la base.
- ARES: falla preexistente en `ares-commercial-ui.test.mjs` porque el selector
  JSX elige una tarjeta que necesita `stepTwoProposalReady`, variable ausente
  del entorno simulado. Test y sus cuatro archivos de producción intactos.
  No se modificaron pruebas ajenas para ocultar estas fallas.

## Navegador y capturas

Edge local con autenticación y base efímera del esquema actual:

- Dashboard real previo al inicio y POST anticipado rechazado con HTTP 409.
- Estados futuros simulados solo mediante respuestas del navegador: 31 créditos,
  drawer parcial, importe excesivo, envío, notificación, comprobante y bandeja.
- Pausa al refrescar cierra drawer y confirmación ya abiertos, conserva 31 créditos
  y presenta los tres textos aprobados y el celular negro triste con lágrima.
- POST de un formulario desactualizado recibe COMMISSION_PAUSED, refresca y cierra
  el panel. Reactivación restaura disponible sin reabrir el formulario.
- Pausa: 320, 390, 768, 1024 y 1672 px sin desbordamiento horizontal.
- Próximamente, cobro parcial y 1.000 créditos: escritorio y móvil sin errores JS.

Capturas de esta revisión en `tmp-commissions-qa/output` y
`output/commissions-qa/pause-*.png` del worktree de revisión. Los importes futuros
son escenarios visuales, no movimientos de vendedores reales. Producción obtiene
sus valores exclusivamente de créditos y pagos de la base de datos.

## Instalación y publicación

Instalador final verificado sobre la base efímera local, incluida repetición del
SQL sin perder datos. La publicación autorizada incorpora el instalador al final
del predeploy de Railway, conservando los pasos existentes. La migración debe
terminar correctamente antes del arranque de la nueva aplicación. El instalador
y su SQL están incluidos en la imagen Docker y verificados por la prueba de
empaquetado. La activación y pausa/reanudación de la pantalla son automáticas.
