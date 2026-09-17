# Crédito finalizado — FINSER PAY Clientes

- La pantalla solo se activa con el estado `PAGADO` que ya entrega la API.
- Comparte composición, tokens, progreso y estilos con el inicio al día/en mora.
- Saldo, cuotas, equipo y último pago provienen del crédito consultado.
- Conserva el controlador de descarga para navegador/Android, sus errores y bloqueo de doble clic, las rutas de recibos y el canal de solicitud de crédito por WhatsApp.
- Navegación: Inicio, Crédito, Historial y SALIR. La salida conserva su comportamiento existente.
- La mascota tiene flotación sutil; `prefers-reduced-motion` la desactiva.

## Mascota

Recurso: `public/assets/clientes/mascot-paid.webp` (640 × 960, transparencia alpha).
Creada con la herramienta integrada `image_gen`, usando como referencia la pantalla enviada por el usuario. Optimizada a WebP para la aplicación.

Prompt exacto:

Use case: background-extraction / stylized-concept. Asset type: transparent web mascot for the paid-off state of FINSER PAY Clientes. Reference: the attached paid-off mobile screen; use ONLY its celebrating black phone mascot as the design reference. Create a standalone full-body premium 3D black smartphone mascot with glossy black eyes and green irises, delighted open smile, both arms lifted in victory, one leg bent and lifted, the other on the ground. Match the character in the supplied image, elegant matte black body with restrained reflections, black gloves and black sneakers. On its screen the exact words "FINSER" in green and "PAY" in white, clearly readable. Only a few subtle green celebration strokes around it. Centered full body with generous uncropped margin, portrait 2:3 canvas, true transparent background with alpha and a soft small contact shadow. No page UI, numbers, dates, labels, device callouts, currency, Apple marks, confetti or balloons. This is a production asset, not a screenshot.

## Verificación

- ESLint del componente, compilación Next.js y TypeScript correctos.
- 16 pruebas de documentos, cierre de crédito, presentación y entrada de pagos correctas.
- Navegador con datos simulados: saldo y cuotas dinámicos, cambio entre pagado/al día/mora, historial vacío, recibos, descarga y reintento de PDF, protección contra doble clic, puente Android, enlace WhatsApp y salida.
- Diseño comprobado a 320, 390, 600 y 1280 px, con foco visible, controles de al menos 44 px y movimiento reducido.
