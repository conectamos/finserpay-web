# Mascota de identidad y firma confirmadas

- Fecha: 2026-10-09.
- Modo: edición/extracción con imagegen integrado (built-in), seguida de una edición de limpieza. Ambas llamadas usaron `transparent_background: true`.
- Referencia del usuario: `C:/Users/Asus/Downloads/FINSER PAY_ Identidad y firma confirmadas.png`.
- Recurso integrado: `public/assets/creditos/identity-signature-confirmed-mascot.png`.
- Salida original conservada: `C:/Users/Asus/.codex/generated_images/01a12378-e8fc-78f2-93fc-aaecb4bc3479/exec-8f09105e-037f-4bbd-81f0-aaff01bf42a4.png`.
- Verificación: PNG RGBA de 1536 × 1024, canal alfa real y fondo transparente. Se inspeccionaron metadatos y píxeles del fondo con Sharp en modo de lectura; por ejemplo, (0, 0), (150, 400), (700, 30), (1400, 500) y (500, 900) tienen alfa 0. No se recortaron ni editaron píxeles con scripts.

## Prompt exacto de generación/extracción

```text
Use case: background-extraction. Asset type: transparent PNG mascot asset for the FINSER PAY web credit identity/signature screen. Input image: the attached screenshot is the exact visual reference and edit target. Extract and faithfully reproduce ONLY the small three-dimensional happy black smartphone mascot at the upper right of the main white card. Preserve its rounded black/charcoal phone body, top notch, happy black glossy eyes with small white highlights, eyebrows, small smiling mouth, subtle dimensional highlights, black rounded hands. Its hand on image-left holds the same white sheet/document with soft pale green horizontal lines and a lime/green circular checkmark; its other hand rests at the bottom-right edge, as though leaning over a card. Preserve the same upright slight tilt and friendly matte 3D render. Text on phone screen verbatim: FINSER in white, below it PAY in vivid green. Preserve small pale green celebratory rays immediately above the document. The asset must contain the entire phone, both hands, and entire paper, tightly composed with a small transparent margin and NO surrounding UI. Real alpha transparency everywhere outside the mascot/paper/rays. Remove the full screenshot background, all card surfaces, lines, text, controls, and cast backdrop. No standalone white rectangle, no fake checkerboard, no floor, no replacement character, no emoji, no turquoise, no phone photograph. High quality clean antialiased cutout with natural transparent edges. Keep it extremely close to the mascot visible in the reference.
```

## Prompt exacto de limpieza

```text
Edit only the isolation/background of this mascot PNG. Remove EVERY outer glow, green aura, gray haze, white halo, spotlight, backdrop shadow and dark background outside the actual solid objects. Return a professionally isolated PNG with genuine alpha transparency: all pixels outside the smartphone, two hands, paper sheet and three short green rays must be completely transparent. Preserve the existing mascot itself exactly: its happy black charcoal 3D phone, face, notch, rounded black hands, white document with green check and pale green lines, three separate green rays, text FINSER white and PAY green, pose, proportions, material and clean antialiased edges. No card, no floor, no fog, no glow around the paper or phone, no fake black matte or checkerboard. Make the boundary clean, with only a tiny natural antialias edge; do not add any lighting outside the actual solid objects.
```
