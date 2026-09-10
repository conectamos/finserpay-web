# Aviso de cupo diario de DataCrédito

## Alcance

El formulario real de clientes nuevos muestra un diálogo de cupo agotado cuando
`POST /api/creditos/datacredito/evaluaciones` responde HTTP 429 con
`ALLY_DAILY_QUERY_LIMIT_REACHED` y un `dailyQuota` íntegro, con `exhausted: true`
y `percentUsed: 100`. No se calcula el porcentaje en el navegador.

El cierre conserva el formulario. Un nuevo intento consulta únicamente el GET
existente `/api/creditos/datacredito/politica`; mientras siga agotado se reabre
el aviso sin enviar otro POST. El botón de verificación, el regreso a la pestaña
y el instante de reinicio comunicado por el servidor permiten refrescar el cupo.
Una respuesta disponible habilita el formulario, pero nunca dispara una consulta
pagada automáticamente. Si falla la lectura, se conserva el bloqueo y se informa
el fallo de verificación sin presentar un rechazo crediticio.

En una solicitud retomada, la lectura recibe `solicitudId` y valida el acceso
existente al propietario antes de consultar su cupo, incluso si la opera central.
La restauración normal de evaluaciones ya aprobadas conserva su flujo original.

Las evaluaciones aprobadas existentes se restauran antes de considerar el cupo.
La reserva atómica existente sigue siendo la autoridad final: resuelve consultas
reutilizables antes del cupo y limita las nuevas consultas por aliado y fecha de
`America/Bogota`. No se modifican scoring, permisos, reglas de solicitudes,
pagos, Android nativo ni las integraciones existentes.

## Navegación

- Aprobadas: `/dashboard/solicitudes?estado=APROBADA`, filtro existente del muro.
- Simulador: `/dashboard/creditos?mode=simulator`, modo existente sin consulta.
- El filtro `APROBADA` conserva su semántica actual; no reclasifica borradores.

## Validación

`npm run test:datacredito` incluye pruebas de contrato y handlers reales del gate.
La prueba concurrente PostgreSQL es opcional en la suite habitual y exige
`DATACREDITO_QUOTA_TEST_DATABASE_URL` apuntando exclusivamente a localhost y a
la base aislada `finserpay_quota_isolated_test`. Crea y elimina solo su esquema
aleatorio de pruebas. No usar producción ni credenciales reales en fixtures.

El diálogo usa `showModal()`, fondo inerte nativo, `aria-modal`, foco contenido,
Escape y restauración de foco. La ilustración es decorativa; todo el mensaje,
el porcentaje y los enlaces son HTML accesible.

## Recurso visual

Archivo: `public/assets/creditos/datacredito-daily-quota-mascot.webp`.
Generado con la herramienta integrada de imágenes, usando la referencia del
usuario, y optimizado a WebP (900 × 1125). No es una captura del modal.

Prompt final: «Decorative illustration for the LEFT panel of a real FINSER PAY
quota modal. Use the user's wide LÍMITE ALCANZADO modal as a style reference,
not the tall APROBADO card. Only one happy anthropomorphic black smartphone on
a matte almost-black backdrop, vertical 4:5, gentle green rim light, white
gloved hands with a thumbs-up, friendly eyes and smile, understated green
approved cards. Nearly front-facing, very subtle tilt. Lower half of screen
completely blank: the website overlays its dynamic percentage ring. No numbers,
percentages, letters, logo, amber rings, warning symbols, UI panels, buttons,
checkerboard, watermark, heavy gradients, turquoise or blue.»

No requiere variables de entorno nuevas en producción ni migraciones.

## Archivos de esta entrega

- `app/dashboard/creditos/datacredito-daily-quota-modal.tsx`
- `app/dashboard/creditos/datacredito-daily-quota-modal.module.css`
- `app/dashboard/creditos/datacredito-prequalification-gate.tsx`
- `app/api/creditos/datacredito/evaluaciones/route.ts`
- `app/api/creditos/datacredito/politica/route.ts`
- `lib/datacredito/daily-quota.ts`
- `lib/datacredito/storage.ts`
- `public/assets/creditos/datacredito-daily-quota-mascot.webp`
- `tests/datacredito-daily-quota.test.mjs`
- `tests/datacredito-daily-quota-gate.test.mjs`
- `tests/datacredito-platform-restore.test.mjs`
- `tests/datacredito-policy-catalog-ui.test.mjs`
- `package.json`
- `docs/DATACREDITO_QUOTA_MODAL.md`

## Resultados de verificación

- DataCrédito: 192 pruebas correctas, dos pruebas PostgreSQL opcionales omitidas
  en la suite habitual. La prueba nueva de cupo PostgreSQL se ejecutó además en
  una base local aislada: 20 intentos simultáneos por el último cupo produjeron
  una reserva aceptada y 19 denegadas. Probados reinicio Bogotá y cupos por aliado.
- Wompi: 19/19. Cierre, simulador e identidad: 65/65.
- Solicitudes: 103/104; fallo previo en `solicitudes-canonical.test.mjs:210`:
  espera tres usos de `errorCode: trackedErrorCode`, pero el código base ya tiene
  cinco. Confirmado contra el commit base `5a76b17`; no se alteró la regla.
- TypeScript y build de producción correctos; 99 páginas generadas, sin ruta QA.
- Lint de todos los archivos modificados correcto. Lint global detecta diez
  errores únicamente en recursos generados de terceros `public/pdfjs/6.3.289/`
  y advertencias previas; estos archivos están excluidos de Git y no se editaron.
- Navegador local: escritorio 1440 px, móviles 390 y 320 px, foco, Escape,
  fondo inerte, botones, cierre y reapertura, GET sin POST, reinicio confirmado y
  separación de fallos 429 genérico/500. APIs interceptadas con datos sintéticos;
  ninguna consulta pagada o cuota de producción fue utilizada para estas pruebas.

La página y el script temporales de QA se eliminaron antes de compilar.
