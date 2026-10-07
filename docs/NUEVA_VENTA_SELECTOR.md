# Nueva venta: selección de equipo

Vista de venta rediseñada según la referencia `Nueva venta_ elige Android o iPhone.png`.
La selección del simulador conserva su pantalla anterior. Las rutas, parámetros,
validaciones e integraciones de la fábrica no se modificaron.

## Recursos 3D

Imágenes PNG de alta calidad con transparencia real, generadas con la herramienta
integrada de generación de imágenes. Se conservó el canal alfa original.

- `public/assets/creditos/android-symbol-3d.png`
- `public/assets/creditos/apple-symbol-3d.png`

### Prompt Android

Use case: stylized-concept. Asset type: transparent PNG for a financial web app
platform selection card. Generate ONLY the classic Android full-body robot
mascot, centered, front facing, lime green, high-quality 3D studio rendering.
Exact recognizable Android silhouette: hemispherical dome head, two slender
antennae angled outward, two small white circular eyes, separate rounded
rectangular torso, two capsule arms, two short capsule legs. Smooth satin green
plastic, soft highlights from upper left and subtle shading; resembles premium
polished 3D app icon, no phone, no text, no badge. Entire robot visible with
generous transparent margins, square canvas, robot fills approximately 78% of
height. Genuine transparent alpha background, delicate diffuse ground contact
shadow under feet fading fully to transparency, no opaque white backdrop. Match
a minimal white UI with lime Android robot shown above Android label.

### Prompt Apple

Use case: stylized-concept. Asset type: transparent PNG for platform selection
card in a premium financial web application. ONLY a recognizable Apple bitten
apple brand symbol rendered as a three-dimensional solid sculptural logo with
detached leaf. Front facing, exact familiar silhouette, bite on right side,
gently rounded bevel and realistic thickness; matte charcoal black satin finish,
subtle soft studio highlights from top left. Centered square canvas, entire
symbol visible, fills 76% of height with generous transparent margins. Genuine
transparent alpha background. A delicate soft diffuse shadow floating slightly
beneath logo fades completely to transparency. No phone, no text, no circle,
no badge, no scene or opaque white background. Match minimal white UI card with
premium black matte 3D Apple logo.

## Componentes y navegación

La vista reutiliza `FinserBrand`, `CentralDashboardMenu` y `LogoutButton`.
El perfil toma el nombre y rol de la sesión. Los módulos administrativos se
muestran solo a administradores; los módulos centrales solo a central; clientes
y recaudos también se ofrecen al supervisor. El servidor sigue aplicando los
controles de acceso existentes.

Las tarjetas son enlaces completos. No tienen selección inicial. Hover y foco
usan el mismo borde verde y elevación discreta; se respeta reduced-motion.
Volver conserva `/dashboard`, el destino anterior.

## Verificación

- TypeScript sin errores; ESLint sin errores en los archivos modificados.
- Comparación visual a 1536 × 1024 contra la referencia: ajuste de encabezado,
  margen de ruta, posición y tamaños de tarjetas y símbolos.
- Chrome: dos tarjetas alineadas y neutrales; Android accesible por Enter;
  iPhone por clic; ambas rutas llegan al modo create-client y a su plataforma.
- Prueba de la página real con sesiones simuladas: central, aliado, asesor y
  supervisor; cada uno conserva su perfil, permisos y destinos Android/iPhone.
  La fábrica de destino se sustituyó por un marcador en la prueba; no se crearon
  créditos ni se realizaron operaciones de enrolamiento en producción.
- 768, 390 y 320 px sin desbordamiento horizontal.
- 39 de 41 pruebas existentes de acceso, catálogo, rango de iPhone y portal de
  enrolamiento pasan. Los mismos dos fallos ocurren al evaluar la versión HEAD
  anterior al rediseño: “las dos rutas resuelven equipoCatalogoId por ID con el
  mismo helper” y “selector y avance usan el mismo rango y no cambian plazos
  enviados o firmados”. Corresponden a aserciones sobre archivos no modificados.

Capturas y registro local de pruebas: `tmp/new-sale-qa/` en el workspace principal.
