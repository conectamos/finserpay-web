# Entrada de FINSER PAY Clientes

La pantalla sigue la referencia del 16 de septiembre de 2026: fondo marfil, encabezado negro mate curvo, marca FINSER verde y PAY blanca, mascota celebrando, título y explicación, una tarjeta blanca con documento y CONTINUAR, soporte y pie seguro.

## Archivos

- Componente: `app/clientes/client-login-screen.tsx`.
- Estilos: `app/clientes/client-login-screen.module.css`.
- Mascota: `public/assets/clientes/mascot-welcome.webp` (WebP con transparencia, 640 × 960).
- Tokens compartidos: `--fp-client-matte` y `--fp-client-muted`, junto con el marfil y los verdes existentes.

Se conservan el callback del formulario, la normalización numérica, documento obligatorio, longitudes de 5 a 20 caracteres, modo numérico, autocompletado y avisos del servidor. Ambas ayudas usan FinserSupportLink y la configuración vigente de lib/support.ts. No se modifican rutas, APIs ni lógica financiera.

## Validación

- Build, TypeScript y ESLint correctos sobre la versión publicada 8b369b3 más este cambio.
- Suite de la versión actual: 1204 pruebas, 1177 pasan, 17 omitidas y los mismos 10 fallos previos ya reproducidos sobre main sin el rediseño.
- Navegador con API interceptada: vacío, documento corto, normalización, consulta GET con documento, envío por Enter, botón ocupado/deshabilitado, error accesible, consulta exitosa y ambos enlaces de WhatsApp.
- Anchos de 320, 390, 460 y 1280 px; foco visible; animación desactivada con prefers-reduced-motion.
- Capturas: `output/client-login-qa/`. Se usaron datos ficticios aislados.
- El build usa una URL PostgreSQL ficticia local solo para generar Prisma; no se accede a datos reales.

## Imagen

Herramienta integrada imagegen, optimización WebP con Sharp conservando alfa.

Prompt inicial:

> Use case: background-extraction. Input: latest user-provided FINSER PAY login screen reference. Extract ONLY the central celebrating 3D black smartphone mascot, preserving its appearance exactly: tall elegant black phone tilted slightly, shiny BLACK eyes with white catchlights (no green irises), wide open friendly smile with white teeth, both black arms raised in a victory pose with fists up, one sneaker slightly raised, black sneakers with white soles. Exact screen branding: FINSER in bright lime green on first line, PAY in white underneath. Keep the four subtle short green celebration strokes near raised arms. Remove ALL interface, header, footer, text outside the phone, form, backdrop. Deliver a premium isolated full-body asset on genuinely transparent PNG background with real alpha, no ivory/white rectangle, no dark halo. Soft small contact shadow allowed. Portrait 1024x1536, character centered, entire body and strokes visible, about 88% of canvas height. No confetti, balloons, extra props, Apple logo or childish elements.

Refinamiento:

> Use case: precise-object-edit. Edit ONLY the four green celebration marks in the latest transparent FINSER PAY celebrating mascot: make them simple short matte green strokes, no neon, no glow, no aura, no bloom. Remove the light halos around character and shoes as well. Keep the entire mascot identity and all geometry unchanged: raised arms, lifted foot, BLACK glossy eyes, wide smile, exact FINSER green / PAY white text, identical pose, framing and alpha transparency. PNG with genuinely transparent background, not a black or white backdrop. Premium subtle studio lighting on the character only.
