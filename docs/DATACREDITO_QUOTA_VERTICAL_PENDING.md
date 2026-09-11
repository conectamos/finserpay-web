# Aviso vertical: preparación pendiente de la ilustración exacta

## Estado

La referencia vertical del 10 de septiembre de 2026 reemplaza el diseño anterior.
Todavía NO se ha implementado ni publicado ese rediseño. El usuario pidió conservar
el celular exacto y solicitar el recurso si no fuera posible separarlo fielmente.
Los recursos actuales no son idénticos. El intento de extracción alteró detalles
del personaje y no produjo transparencia real; no se incluyó en el proyecto.
Se solicitó el celular con su moneda, preferiblemente PNG/WebP transparente.

No integrar otra mascota ni publicar esta preparación como si el rediseño estuviera
terminado. Faltan el recurso aprobado, JSX/CSS vertical, contenido exacto y QA visual.
Se debe reutilizar el diálogo accesible de DataCrédito y sus rutas actuales.

## Preparación implementada en esta rama

- El estado bloqueado se comprueba por GET cada 30 segundos mientras la pestaña
  está visible y al volver a enfocarla/mostrarla. Ya no depende de `Date.now()`.
- Solo una respuesta válida del backend elimina el bloqueo; los intentos de
  consulta continúan protegidos en el servidor y no se envían POST automáticos.
- `formatQuotaRehabilitationDate(resetsAt)` prepara el formato español de la fecha
  ISO del backend en `America/Bogota`. Devuelve null ante fechas inválidas. Todavía
  no está conectado al texto del modal: se usará al completar el rediseño.
- El backend existente se mantiene intacto: su fecha real de rehabilitación ya
  corresponde a la siguiente medianoche colombiana. No hay discrepancia de regla.

## Verificación

- Suite DataCrédito: 199 correctas; dos pruebas PostgreSQL opcionales omitidas en
  la corrida habitual. La prueba del cupo sí se ejecutó aparte con PostgreSQL local
  aislado: cinco pruebas correctas, sin omisiones.
- Casos PostgreSQL: concurrencia de 20 peticiones por el último cupo, cambio de
  día/mes/año, febrero normal y bisiesto, medianoche colombiana vs. UTC y
  conservación del contador del día anterior.
- Casos frontend: fecha formateada desde el servidor, reloj 1990/2099 sin efecto,
  pestaña oculta/visible, foco, limpieza/cancelación, respuesta agotada/disponible
  y ausencia de nuevas consultas pagadas automáticas.
- Lint de los archivos modificados, TypeScript y build correctos.
- No se ha probado visualmente el diseño vertical ni desplegado esta rama en producción: falta
  la ilustración exacta. No se modificaron scoring, cuotas configuradas, consumo,
  reglas financieras, permisos, solicitudes, pagos ni integraciones.

## Archivos de preparación

- `app/dashboard/creditos/datacredito-prequalification-gate.tsx`
- `lib/datacredito/quota-rehabilitation-date.ts`
- `tests/datacredito-daily-quota-gate.test.mjs`
- `tests/datacredito-daily-quota.test.mjs`
- `tests/datacredito-quota-rehabilitation-date.test.mjs`
- `package.json`
- `docs/DATACREDITO_QUOTA_VERTICAL_PENDING.md`
