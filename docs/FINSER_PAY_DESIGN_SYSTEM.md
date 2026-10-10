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

### Centro del analista

La referencia aprobada del Centro usa cabecera horizontal con `FinserBrand`,
perfil nominal y dos grupos de accesos. Reutiliza la tipografia Roboto ya
incluida en las pantallas aprobadas, los controles compartidos y los iconos
Lucide. El fondo combina `--fp-client-bg` y `--fp-surface` para conservar el
porcelana calido de la referencia; los neutros `#626660` y `#dedfdb` son los
de la variante existente de analistas. Estos ajustes quedan limitados al
contenedor nominal. Los accesos por enlace conservan su cabecera y alcance.
La pantalla inicial solo presenta la consulta y los modulos; los expedientes
y formularios se muestran tras una accion explicita. Los identificadores de
los resultados nominales se muestran completos conforme a la referencia.

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

## Inicio de FINSER PAY Clientes

La referencia móvil aprobada usa los tokens compartidos `--fp-client-bg` (marfil),
`--fp-client-green` (texto verde con contraste AA), `--fp-client-action` (acción y
avance) y `--fp-client-soft` (recordatorio). Esta variante conserva Button y
ProgressBar compartidos, con botones redondeados y una única superficie para
«Tu actividad». La mascota es una ilustración de marca; el equipo financiado
se identifica mediante la referencia real del crédito, sin fotos de catálogo.
Los estados y la disponibilidad de liquidación provienen del servidor.

## Entrada de FINSER PAY Clientes

La referencia aprobada usa una cabecera negra mate curva y una única tarjeta
blanca de consulta sobre el marfil compartido. Los tokens `--fp-client-matte`
y `--fp-client-muted` mantienen negro y gris neutros sin matices azules.
Se reutilizan Button y FinserSupportLink. Los controles tienen áreas táctiles
de al menos 44 px; la mascota respeta prefers-reduced-motion.

## Informe de consultas y ventas

La referencia aprobada para `/dashboard/reportes/datacredito-ventas` usa navegación
superior blanca con marca sobre grafito, en la variante `reports` de
`FinserNavigation`. Conserva los menús y permisos de la plataforma. Los indicadores
principales forman una franja grafito; los resultados comerciales usan una fila
blanca. Los contornos y separadores usan `--fp-border`; los controles y tablas
reutilizan `finser-ui`. El buscador se limita a la tabla de mayor actividad;
las exportaciones incluyen el período y aliado del resultado consultado completo.
Las ayudas son accesibles con foco y al pasar el cursor. En móvil los indicadores
se distribuyen en dos columnas y las tablas permiten desplazamiento horizontal.
El PDF sigue la referencia aprobada de portada y detalles A4 horizontal, con
paginación de todos los registros y empates, fuente Roboto y marca grafito/lima.

## Liquidaciones guardadas de aliados

El detalle histórico de `/dashboard/pagos-aliados` reutiliza la navegación
`settlement`, los iconos SVG de plataforma y los formatos compartidos. Su
composición separa encabezado, franja de registro, dos resúmenes de producto,
saldo grafito y tabla con un máximo de diez créditos por página. Presenta
únicamente valores confirmados; la previsualización editable es una vista distinta.
Los resúmenes y comprobantes incluyen toda la liquidación. Al cerrar, el historial
permanece montado y conserva filtros, tamaño de página, página, posición y foco.
Los recaudos se consultan desde una franja compacta; sin registros asociados no
se muestra una tabla vacía. Montos y porcentajes guardados conservan sus decimales.

## Nueva venta: validacion inicial del cliente

El paso inicial usa cabecera blanca compacta, marca oscura con PAY verde,
usuario real y los cuatro pasos existentes. La tarjeta central presenta campos
verticales y una mascota independiente transparente apoyada en la esquina
superior derecha. Esta variante se limita a la evaluacion inicial; conserva los
componentes y tokens compartidos sin alterar los pasos posteriores.
La autorizacion comienza desmarcada y su texto vigente completo se despliega
desde el enlace correspondiente. No se consulta DataCredito al abrir la vista.
El boton solo se habilita con identificacion valida y autorizacion; durante el
envio permanece bloqueado. Los errores conservan los datos para corregirlos.
En movil se reduce la mascota sin cubrir controles. El recurso es estatico y
la preferencia de movimiento reducido tambien detiene el indicador animado.


## Nueva venta: enrolamiento y entrega

El cierre reutiliza la cabecera blanca compacta de Nueva venta y conserva sus
cuatro pasos. La informacion del caso se organiza dentro de una sola superficie:
estados reales de contrato y enrolamiento, franja del equipo, cliente y solicitud,
y tres acciones en orden: remision, enrolamiento y evidencias. Apple y Android
reutilizan los SVG de plataforma. El detalle conserva cedula e IMEI completos.
La remision se imprime bajo demanda y no registra una firma. Las cinco evidencias
solo se habilitan al confirmar el enrolamiento y muestran su persistencia real.
Las herramientas administrativas se agrupan en un desplegable exclusivo; cada
formulario empieza cerrado y conserva sus validaciones y nueva firma obligatoria.
El boton de cierre explica el requisito pendiente. En movil las acciones se apilan
y los formularios mantienen sus controles sin desbordarse.

## Nueva venta: equipo, plan, identidad y firma

Los pasos 2 y 3 reutilizan la cabecera blanca compacta y los cuatro pasos de
Nueva venta. Equipo y Plan forman una tarjeta con separadores; la propuesta usa
grafito, importes completos y las fórmulas existentes. La frecuencia y el primer
pago conservan su cálculo automático. El catálogo se presenta sin repetir la
marca; cuando no existe imagen del modelo se reutilizan los SVG de plataforma.
La tabla de amortización comienza plegada. Los campos protegidos conservan el
procedimiento de corrección y nueva firma.

Antes de avanzar se solicita la reescritura del IMEI en un diálogo accesible,
con fondo desenfocado y sin revelar el valor anterior. La confirmación se vincula
en el servidor al IMEI vigente, solicitud, usuario y fecha; cualquier cambio la
invalida y conserva su historial.

Identidad y firma presentan una franja con estados independientes confirmados por
el servidor, mascota con documento y acciones disponibles según permisos. Al
confirmarse la versión vigente se destaca Contrato firmado, los cuatro hitos y
el siguiente paso; las correcciones pendientes requieren nueva firma. Mientras haya un proceso
pendiente se consulta exclusivamente el estado local cada cinco segundos; los
webhooks conservan la actualización del proveedor. Al desconectarse se informa
Reconectando y se ofrece Reintentar. La firma no avanza automáticamente a entrega.
En móvil las secciones se apilan y todos los campos y acciones quedan accesibles.
