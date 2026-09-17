# Rediseño de FINSER PAY Clientes

## Implementación

- Pantalla: `app/clientes/client-active-credit-dashboard.tsx`.
- Ambos estados dependen de `estadoPago` del crédito recibido por la API existente.
- La cuota conserva `saldoPendiente`, `fechaVencimiento` y el plan original.
- La liquidación muestra `liquidacionAnticipada.capitalPendiente` y conserva el callback de confirmación.
- En mora el botón de liquidación permanece visible y se puede consultar; la regla existente impide procesarla y muestra `motivo`. No se habilitó una operación que el servidor prohíbe.
- La referencia del equipo proviene de `referenciaEquipo`; no hay fotos genéricas ni marcas gráficas de fabricantes.
- El recordatorio calcula únicamente días de calendario en Colombia. No decide mora ni calcula importes.
- Se reutilizan Button y ProgressBar y los tokens compartidos; animaciones de respiración y parpadeo se desactivan con movimiento reducido.
- En el workspace original se excluyeron copias temporales de TypeScript; ese ajuste local no es necesario ni se incluye en la publicación aislada.

## Recursos

Generados con la herramienta integrada imagegen y optimizados a WebP con transparencia:

- `public/assets/clientes/mascot-current.webp`
- `public/assets/clientes/mascot-overdue.webp`

Los prompts exactos se conservan en `public/assets/clientes/mascot-prompts.json`.

## Validación

- 256 pruebas de Node pasan, incluidas tres nuevas para el calendario de Colombia, fechas ausentes, hoy y mañana.
- TypeScript sin errores y ESLint de los archivos TypeScript modificados sin errores.
- Build de producción correcto. El entorno no tenía DATABASE_URL; se usó exclusivamente para el proceso de build una URL ficticia de PostgreSQL local, sin modificar archivos de entorno ni conectar a datos reales.
- Chromium/Edge con respuestas de API simuladas: ambos estados, acciones de cuota, confirmación de liquidación al día y restricción en mora.
- Anchos de 320, 390, 600 y 1280 px; referencias largas e importes grandes; sin desbordamiento horizontal ni errores de JavaScript.
- Foco de teclado visible y prefers-reduced-motion verificado.
- Capturas de prueba en `output/client-dashboard-qa/`. Los nombres e importes de estas capturas son fixtures aislados; no están incorporados a la aplicación.

## Validación de publicación

- Integración sobre main 19b532e, conservando onPayInstallment y la confirmación directa de la próxima cuota.
- Build con comprobación TypeScript y ESLint correctos en la copia de publicación.
- Suite actualizada: 1204 pruebas; 1177 pasan, 17 omitidas y 10 fallos previos. Los mismos 10 fallos se reprodujeron sobre main sin cambios (ARES, ubicaciones, cierre/IMEI, vista de cuota, blacklist y Veriff).
- Prueba de navegador repetida sobre el build integrado: ambos estados, confirmación directa, restricción de liquidación, cuatro anchos, foco y movimiento reducido correctos.
