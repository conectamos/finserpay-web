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
La pantalla inicial presenta la consulta en una superficie grafito con acentos lima,
seguida por dos grupos blancos de accesos con iconos sobre porcelana. La consulta
usa el boton lima como accion principal y se apila en movil. Solo presenta la consulta y los modulos; los expedientes
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

El ajuste de un plan con amortización aprobada se habilita exclusivamente al
administrador central de FINSER PAY. Dentro de Gestionar crédito se solicita el
motivo antes de confirmar. La revisión conserva el contrato, la amortización
original y los abonos; el expediente y el plan de pagos muestran los valores
vigentes, y los recibos anteriores conservan las condiciones de su registro.

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

## CRM de Atención

Atención reutiliza la cabecera horizontal de la plataforma: `FinserNavigation`
en su variante administrativa para central y `AnalystNavigation` para el perfil
nominal. Usa porcelana, grafito y acentos lima; no añade una navegación lateral,
mascotas ni una segunda barra de búsqueda. Una franja compacta agrupa las vistas
del módulo y el estado real de conexión.

La vista inicial es Conversaciones, con bandeja y chat amplio en dos columnas.
La ficha se abre bajo demanda en `FinserSidePanel`, sin comprimir el historial.
El panel conserva formularios al cerrarse y restituye el foco al control de origen;
la pérdida de acceso retira los datos protegidos. Las confirmaciones financieras
permanecen dentro del panel nativo y se cierran antes que él.

La tipografía operativa usa 16 px y los controles frecuentes tienen al menos
44 px. La identidad es compacta; la etiqueta automática FINSERPAY se distingue de
las etiquetas manuales de seguimiento. El resumen financiero pide seleccionar
crédito si hay varios y presenta estado, prórroga y último recibo. Notas y tareas
se agrupan en Seguimiento. `ConfirmDialog` muestra crédito, destinatario y fecha
o importe antes de actuar. El grabador ofrece escucha previa y los emojis se
insertan en el borrador. La recepción en tiempo real conserva texto y posición
de lectura; los fallos de conexión muestran su estado y activan consulta local.
La prórroga puede concederse antes de vencer la primera cuota regular pendiente:
sus 1 a 4 días se cuentan desde el vencimiento 02/17, con límite 06/21. La
confirmación identifica la cuota y su fecha; un pago que cambie esa cuota obliga
a revisar los datos nuevamente. Los créditos pagados no habilitan esta acción.
Al aprobar desde Atención, la misma operación añade una gestión al muro de
Gestión de cartera con responsable, motivo, observación y compromiso confirmado.
La revisión anuncia el seguimiento a las 08:00 de Bogotá del día siguiente al
compromiso. El resultado enlaza al historial del crédito. Un conflicto ofrece
«Actualizar cuota y revisar», conserva el borrador y exige confirmar de nuevo.
En móvil se pasa de bandeja a chat, con ficha superpuesta y desplazamiento sin
cortar mensajes ni controles de envío.

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

## Historial DataCrédito

`/dashboard/datacredito` usa la navegación horizontal blanca compartida en su
variante administrativa, con marca sobre grafito e Integraciones seleccionado.
Conserva el acceso exclusivo del administrador central y el enlace de ayuda.
Los indicadores grafito describen la integración y únicamente las consultas
cargadas; no representan totales globales del historial. Los filtros y la tabla
ocupan el ancho disponible, sin dividir permanentemente lista y expediente.

El expediente aparece al seleccionar una consulta. Su cierre conserva la lista,
los filtros y el foco. Las secciones MiDecisor y las ayudas extensas son
desplegables; advertencias, estados y ausencia de información permanecen
explícitos. La tabla mantiene desplazamiento horizontal propio en móvil y la
acción Ver queda fija en su extremo derecho. Se reutilizan los controles,
estados y tokens compartidos, incluida la tipografía Roboto de la navegación.

El rediseño conserva la búsqueda administrativa POST con cédula en el cuerpo,
el detalle protegido GET, la auditoría y la retención. Consultar este historial
no inicia evaluaciones del proveedor ni genera consultas pagas.

## Parámetros de crédito

Las cuatro pestañas de `/dashboard/parametros-credito` comparten cabecera blanca,
tarjetas con borde fino y los controles de `finser-ui`. Los indicadores del
catálogo forman una franja grafito y reflejan el estado real de la integración.
Políticas presenta un selector y resumen compacto, con Mora TELCOS, Mora total
y Bandas de puntaje inicialmente plegadas. Los parámetros financieros y las
ayudas extensas permanecen disponibles en desplegables. Las advertencias de
acciones deshabilitadas se mantienen visibles. Aliados conserva todas sus
asignaciones y cupos diarios en una tabla desplazable. Cupos por cédula y Segundo
crédito presentan consulta, estado y gestión con el mismo estilo. Cambiar de
pestaña conserva los formularios iniciados; la presentación no altera revisiones,
valores financieros, autorizaciones ni permisos.

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
La fábrica no incluye el buscador de asistencia administrativa; los casos se
retoman desde los módulos existentes y sus enlaces directos.
En movil se reduce la mascota sin cubrir controles. El recurso es estatico y
la preferencia de movimiento reducido tambien detiene el indicador animado.


## Cartera en mora del analista

La vista operativa conserva la cabecera del Centro del analista y las superficies
compartidas. La tabla agrupa crédito y cliente, aliado y equipo, importe vencido,
última gestión, seguimiento y estado; el detalle usa `FinserSidePanel` para no
comprimir la tabla. Los filtros principales son búsqueda, aliado y estado; los
adicionales se despliegan desde Más filtros. Las prórrogas aprobadas vigentes usan
el estado Prórroga, acento ámbar y vencimiento visible, también junto al cliente
en móvil. El detalle informa motivo y autorización. Este estado proviene de la
solicitud de prórroga y conserva el historial de gestión anterior; una gestión
que mencione una prórroga no equivale a una autorización. Al actualizar se
consultan listado y detalle sin borrar el formulario que se esté completando.

El panel permite editar o cancelar la prórroga vigente sin navegar a otro
módulo. Se consulta de nuevo la autorización y su versión antes de mostrar el
formulario. El analista conserva los límites de cuatro días y las fechas 06/21;
el administrador central mantiene sus permisos de corrección. La cancelación
exige revisión explícita y conserva el historial. La confirmación se presenta
dentro del panel nativo para mantenerla visible y accesible en su misma capa.
Los cambios actualizan la cartera y el detalle conservando el borrador de gestión;
un conflicto de versión exige consultar la autorización antes de reintentar.

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

En Equipo y plan, el administrador central dispone de «Editar cuotas» cuando
existe un contrato firmado vigente. El desplegable pide el nuevo número de cuotas
y el motivo, conserva venta e inicial del contrato sellado y reutiliza la
corrección contractual auditada. Confirmar conserva el contrato anterior y vuelve
a Identidad y firma; no envía automáticamente el nuevo contrato. Los campos
protegidos siguen bloqueados para la edición ordinaria y los demás perfiles.

Equipo y plan y el Simulador de crédito comparten la propuesta grafito, la
mascota animada independiente y el respaldo SVG del equipo. Las condiciones se
consultan desde «Ver condiciones». La simulación conserva sus políticas y no
presenta cupos como aprobados, pasos de venta ni estados de firma o borrador.
La cuota y la amortización dejan de presentarse como vigentes con datos inválidos.

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
