# Aviso vertical de límite diario de DataCrédito

## Estado

La referencia vertical del 10 de septiembre de 2026 reemplaza el diseño anterior.
El JSX/CSS vertical y la conexión de la fecha del backend están implementados.
El usuario entregó la mascota exacta
en `ChatGPT Image 10 sept 2026, 19_30_12.png`: teléfono triste con moneda vacía.
El original tiene un cuadriculado pintado (RGB, sin alfa). La herramienta integrada
de imágenes devolvió nuevamente RGB, sin transparencia real. Ese resultado no se
incluyó en el proyecto. El usuario autorizó expresamente el procesamiento local
para retirar el fondo conservando la mascota. Se extrajo el exterior y el hueco
entre brazo y teléfono, sin repintar el personaje; solo se suavizó el alfa del
contorno hacia el interior. La imagen original permanece sin modificar.

Recurso final: `public/assets/creditos/datacredito-daily-quota-sad-mascot.png`.
PNG RGBA de 1145 x 1374 px, 954198 bytes, con 950971 píxeles totalmente
transparentes, 6646 píxeles de alfa parcial y 615613 opacos. La moneda está vacía
en el archivo: el componente superpone `percentUsed` procedente del backend.
No es una captura del modal. Se comprobó el recorte sobre crema y sobre negro.
La comparación binaria con el original confirmó cero píxeles RGB visibles
repintados (622259 píxeles visibles conservados).

La indicación aplicada al procesamiento local autorizado fue: retirar únicamente
el cuadriculado exterior y de los huecos, conservar los píxeles del teléfono
triste y la moneda, guardar PNG con alfa real y dejar la moneda sin texto.
No se utilizó generación adicional ni se sustituyó la mascota.

## Implementación

- El estado bloqueado se comprueba por GET cada 30 segundos mientras la pestaña
  está visible y al volver a enfocarla/mostrarla. Ya no depende de `Date.now()`.
- Solo una respuesta válida del backend elimina el bloqueo; los intentos de
  consulta continúan protegidos en el servidor y no se envían POST automáticos.
- `formatQuotaRehabilitationDate(resetsAt)` prepara el formato español de la fecha
  ISO del backend en `America/Bogota`. Devuelve null ante fechas inválidas y está
  conectado al texto del modal mediante `resetsAt`.
- El modal mantiene una columna, crema, cabecera negra ondulada, marca HTML,
  mensajes y acciones exactos. El porcentaje se renderiza como HTML separado.
- El verde sobrio `#428b2d` está limitado a la marca y acción de este aviso para
  respetar la referencia aprobada. El resto reutiliza tokens y componentes.
- Las acciones conservan `/dashboard/solicitudes?estado=APROBADA` y
  `/dashboard/creditos?mode=simulator`; no se agregan rutas de producto.
- No se necesitan variables de entorno nuevas ni migraciones.
- El backend existente se mantiene intacto: su fecha real de rehabilitación ya
  corresponde a la siguiente medianoche colombiana. No hay discrepancia de regla.

## Verificación

- Suite DataCrédito: 206 correctas; dos pruebas PostgreSQL opcionales omitidas en
  la corrida habitual. La prueba del cupo sí se ejecutó aparte con PostgreSQL local
  aislado: cinco pruebas correctas, sin omisiones.
- Casos PostgreSQL: concurrencia de 20 peticiones por el último cupo, cambio de
  día/mes/año, febrero normal y bisiesto, medianoche colombiana vs. UTC y
  conservación del contador del día anterior.
- Casos frontend: fecha formateada desde el servidor, reloj 1990/2099 sin efecto,
  pestaña oculta/visible, foco, limpieza/cancelación, respuesta agotada/disponible
  y ausencia de nuevas consultas pagadas automáticas.
- Lint de los archivos modificados, TypeScript y build correctos.
- El PNG tiene cuatro pruebas: dimensiones/alfa, esquinas y huecos transparentes,
  píxeles originales opacos de cara/moneda y bordes de alfa parcial.
- Layout medido en Chrome en siete tamaños, sin desbordamiento horizontal;
  móviles bajos conservan desplazamiento vertical interno. El cierre móvil se
  subió 6 px para mantener la X blanca completamente sobre negro.
  Comparación visual final con la referencia aprobada: personaje exacto, moneda
  alineada con porcentaje HTML, crema, cabecera ondulada y acciones correctas.
  No se modificaron scoring, cuotas configuradas, consumo,
  reglas financieras, permisos, solicitudes, pagos ni integraciones.
- Wompi 19/19 y cierre/simulador/identidad 65/65. Solicitudes 103/104: fallo previo
  en `solicitudes-canonical.test.mjs:210` (espera 3 usos, la base contiene 5).
  Tanto la ruta como ese test son idénticos a `origin/main` (`cb2bdc9`).
- Lint global tiene diez errores preexistentes en archivos generados de terceros
  `public/pdfjs/6.3.289/`; no se modifican esas dependencias.
- Navegador Chrome con Gate real: 1440x900, 1366x768, 390x844 y 320x740;
  sin texto recortado ni desplazamiento horizontal. Diálogo nativo, fondo
  oscurecido/desenfocado, Tab/Shift+Tab, Escape y restitución del foco correctos.
- El reintento bloqueado solo realiza GET; estado disponible habilita el siguiente
  intento deliberado y conserva el resultado aprobado. 429 genérico, 500 y fallo
  de red no muestran el aviso. Cinco POST y ocho GET fueron interceptados con
  fixtures locales: cero consultas reales a proveedores y cero consumo productivo.
- Ambos href y su clic/cierre se verificaron con destinos locales interceptados.
  No se contó con una sesión de UAT autenticada para abrir expedientes reales;
  no se modificaron permisos para eludir ese acceso.
- La página temporal y el script QA se retiran antes del build y no se publican.

## Archivos modificados respecto a la entrega anterior

- `app/dashboard/creditos/datacredito-prequalification-gate.tsx`
- `app/dashboard/creditos/datacredito-daily-quota-modal.tsx`
- `app/dashboard/creditos/datacredito-daily-quota-modal.module.css`
- `lib/datacredito/quota-rehabilitation-date.ts`
- `public/assets/creditos/datacredito-daily-quota-sad-mascot.png`
- `tests/datacredito-daily-quota-gate.test.mjs`
- `tests/datacredito-policy-catalog-ui.test.mjs`
- `tests/datacredito-daily-quota.test.mjs`
- `tests/datacredito-quota-rehabilitation-date.test.mjs`
- `tests/datacredito-quota-mascot.test.mjs`
- `package.json`
- `docs/DATACREDITO_QUOTA_VERTICAL.md` (renombra el documento de preparación)
- `docs/DATACREDITO_QUOTA_MODAL.md`
