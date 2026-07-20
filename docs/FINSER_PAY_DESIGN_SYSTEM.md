# FINSER PAY Design System

Este documento define la linea visual oficial de FINSER PAY. Aplica a cualquier
pantalla nueva y a todo rediseño posterior, incluso cuando la solicitud no repita
estas reglas.

## Principios

- La interfaz debe sentirse financiera, premium, sobria y profesional.
- El sidebar usa azul marino o grafito; el area principal usa blanco porcelana o
  gris muy claro.
- El negro grafito es el color principal de textos, botones y superficies
  destacadas.
- El verde lima se reserva para acentos, seleccion, progreso, acciones
  importantes y estados positivos.
- El ambar suave comunica alertas y vencimientos. El rojo se reserva para mora,
  errores y acciones peligrosas.
- El turquesa no se usa como color principal.
- La tipografia debe ser clara y legible, sin textos diminutos para informacion
  operativa.
- Los bordes son finos, las sombras discretas y los radios consistentes.
- El espaciado usa una escala uniforme de 4, 8, 12, 16, 24, 32 y 40 px.
- Cada seccion tiene una sola accion principal.
- Se evitan tarjetas anidadas, grandes bloques de color sin funcion, botones
  repetidos y ruido ornamental.
- Los estados usan componentes consistentes y siempre contemplan carga, vacio,
  error y deshabilitado.
- Las acciones financieras y peligrosas requieren confirmacion; las peligrosas
  se separan de las acciones normales.
- Las referencias visuales aprobadas por el usuario son la guia principal de
  composicion, proporcion y jerarquia.

## Tokens

Los tokens viven en `app/globals.css` bajo el prefijo `--fp-*`.

### Color

| Token | Uso |
| --- | --- |
| `--fp-bg` | Fondo porcelana de la aplicacion |
| `--fp-surface` | Superficie blanca |
| `--fp-navy` | Sidebar y navegacion oscura |
| `--fp-graphite` | Texto y acciones principales |
| `--fp-muted` | Texto secundario |
| `--fp-border` | Divisores y contornos |
| `--fp-lime` | Acento, progreso y seleccion |
| `--fp-lime-soft` | Fondo positivo discreto |
| `--fp-amber` / `--fp-amber-soft` | Alertas y vencimientos |
| `--fp-danger` / `--fp-danger-soft` | Mora, error y peligro |

### Forma y elevacion

- Radio pequeno: `--fp-radius-sm`.
- Radio de controles: `--fp-radius-md`.
- Radio de superficies: `--fp-radius-lg`.
- Sombra de superficie: `--fp-shadow-sm`.
- Sombra elevada: `--fp-shadow-md`.

## Componentes compartidos

Los componentes base se exportan desde `app/_components/finser-ui.tsx`:

- `AppShell`, `Sidebar`, `Topbar` y `PageHeader` estructuran las pantallas.
- `Card`, `MetricCard`, `DataTable` y `Tabs` organizan contenido sin anidar
  superficies innecesarias.
- `Button`, `Input` y `Select` unifican controles.
- `Badge`, `StatusPill` y `ProgressBar` unifican estados y progreso.
- `EmptyState` y `LoadingState` cubren estados operativos.
- `ConfirmDialog`, en `app/_components/finser-confirm-dialog.tsx`, confirma
  operaciones financieras o peligrosas.

Los componentes pueden extender clases para necesidades de layout, pero sus
colores, radios y estados no deben redefinirse localmente sin una razon de
producto documentada.

## Patrones de pantalla

### Navegacion

- El sidebar mantiene ancho y orden estable en escritorio y se contrae en movil.
- El item activo usa una superficie grafito aclarada y una linea lima; no un
  bloque turquesa.
- La barra superior es compacta y separa navegacion, ayuda y perfil.

### Formularios financieros

- El total calculado, el dinero recibido y el cambio se muestran como conceptos
  distintos.
- La accion primaria incluye el valor que se va a aplicar cuando sea util.
- Un estado deshabilitado explica por que no puede continuar.
- Los envios se bloquean mientras hay una solicitud en curso.

### Expedientes

- La identidad del cliente es compacta; la foto es secundaria.
- El resumen financiero aparece antes del detalle documental.
- Las acciones frecuentes se agrupan y las peligrosas viven en un menu separado.
- Los identificadores sensibles, como IMEI, se enmascaran en vistas generales.

### Tablas y documentos

- Las tablas priorizan lectura, alineacion numerica y estados escaneables.
- Los PDF usan A4, tipografia legible y datos dinamicos sin ejemplos escritos a
  mano.
- Los documentos deben conservar legibilidad al imprimir o compartir por
  mensajeria.

## Accesibilidad y responsive

- Contraste minimo AA en texto y controles.
- Foco visible y navegacion completa con teclado.
- Areas interactivas de al menos 40 px de alto.
- En pantallas estrechas, columnas se apilan y tablas conservan desplazamiento
  horizontal sin cortar contenido.
- Iconos decorativos se ocultan a lectores de pantalla; acciones solo con icono
  requieren una etiqueta accesible.
