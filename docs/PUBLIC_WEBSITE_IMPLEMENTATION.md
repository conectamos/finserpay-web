# Web pública FINSER PAY — integración y verificación

La página pública se implementa en `app/page.tsx` para `/`; el acceso comercial
está en `/aliados` y el portal existente continúa en `/clientes`.

## Referencia y diseño

Fuente aprobada: https://finserpay-comercios-clientes.andres03bk.chatgpt.site/
(versión 5 consultada mediante la cuenta conectada, 27 de septiembre de 2026).
Se reutilizaron sus dos recursos de mascota, textos, disposición y campos de
postulación. La implementación usa CSS Modules, FinserBrand, Button, Input y los
tokens compartidos `--fp-*`, con FINSER blanco y PAY lima. No modifica estilos
globales de los portales.

El sitio público reproduce el WhatsApp de la referencia: +57 312 408 5562.
Los portales conservan su canal operativo configurado en `lib/support.ts`.
Los datos publicados de Bre-B (902052909) y Efecty (113950) proceden de la
referencia aprobada; no se realizaron pagos de prueba.

## Funcionalidad

- Enlaces de clientes a `/clientes` y de aliados a `/aliados`.
- Login, cookies, sesiones y APIs de los portales se conservan.
- El formulario exige propietario, comercio, celular, ciudad, correo, web o red
  social y consentimiento. NIT es opcional, como en la referencia.
- La confirmación aparece únicamente tras guardar la solicitud.
- Clave de envío persistida en sessionStorage sin datos personales; el servidor
  deduplica tanto reintentos como solicitudes idénticas durante 24 horas.
- Correo al destinatario fijo comercial@finserpay.com, pendiente ante fallo.
- Reintentos automáticos del servidor cada cinco minutos y al iniciar, más
  endpoint administrativo protegido. No requiere un navegador abierto.
- El diseño contempla móvil, teclado, errores, carga y movimiento reducido.

Configuración de correo y operación: [POSTULACIONES_COMERCIOS.md](POSTULACIONES_COMERCIOS.md).

## Comprobaciones realizadas localmente

- TypeScript y ESLint dirigidos: sin errores.
- 13 pruebas backend aprobadas, incluidas transacciones SQL en PostgreSQL
  aislado (PGlite), validación, idempotencia, fallos de proveedor, concurrencia,
  recuperación tras caída y prevención de duplicados al vencer las claves.
- Navegador Chrome con PostgreSQL 18 local aislado: envío de formulario real,
  guardado de todos los datos, estado PENDING por ausencia de proveedor,
  confirmación y reintento sin duplicar.
- HTTP200 en `/`, `/aliados` y `/clientes`; usuario sin sesión que visita
  `/dashboard` redirigido a `/aliados`.
- Comprobación de ausencia de desbordamiento horizontal a 320, 390, 768, 820,
  1024 y 1440px; menú móvil con Tab/Escape y mascota estática con movimiento
  reducido. Sin errores JavaScript en esas comprobaciones.
- Pruebas de middleware y PWA existentes aprobadas.

Estas comprobaciones se complementaron con entregas reales de correo, pero no con una
validación autenticada de todos los procesos financieros.

## Estado de publicación

El 27 de septiembre se comprobó que producción y `origin/main` usan
`007fadf522d9b55e84c65bf0e37bd7e85263f752`. El checkout original estaba
232 commits por detrás y contenía trabajo previo sin confirmar. Se preparó la
rama `codex/public-finserpay` sobre esa base actual en un worktree gestionado,
aplicando únicamente esta integración y conservando los cambios de producción,
incluido el acceso de analistas a `/dashboard/aprobaciones`. No desplegar el
checkout original completo.

Configuración del servicio web Railway, entorno `production`, verificada sin
mostrar secretos: `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`,
`MERCHANT_APPLICATION_FROM=FINSER PAY <postulaciones@finserpay.com>` y
`MERCHANT_APPLICATION_RETRY_TOKEN`. El dominio `finserpay.com` figura como
`verified` en Resend. No falta ninguna variable obligatoria para las
postulaciones. `FINSERPAY_INTERNAL_CRON` es opcional y se activa por defecto
en producción; `CRON_SECRET` también es opcional porque existe el token de
reintentos.

Se usó el build de producción contra PostgreSQL 18 local aislado y la clave
Resend del servicio. La primera postulación se guardó y confirmó al comercio;
el proveedor la aceptó, pero su UUIDv7 reveló una validación demasiado
restrictiva. Se corrigió la validación sin cambiar el UUID de la solicitud ni
el contenido, y se reintentó con la misma clave de idempotencia. Resend marcó
ese correo como `delivered` y el usuario confirmó su recepción completa en
`comercial@finserpay.com`.

Con el build corregido, una segunda postulación de prueba se guardó y envió
automáticamente en el primer intento. El correo contenía todos los campos,
Resend devolvió el mismo identificador al repetir la solicitud y marcó el
correo como `delivered`. Ambas pruebas tienen una sola solicitud y una sola
notificación aceptada en el proveedor. Los datos de prueba permanecen
únicamente en la base local aislada, no en producción.

Al publicar la rama validada, verificar nuevamente las tres rutas y el
funcionamiento del formulario en el dominio real.

## Verificación de la versión compilada para producción

Se compiló satisfactoriamente el worktree sobre `007fadf5`: build Next.js,
TypeScript y ESLint sin errores. Las pruebas dirigidas de postulaciones, cron y
empaquetado pasaron 16/16, sin omisiones.

El servidor standalone compilado se verificó en `http://localhost:3101` con
PostgreSQL 18 separado, cron financiero desactivado y datos exclusivamente
sintéticos. Se repitió el flujo completo del formulario y la inspección
responsive. Además pasaron 20/20 pruebas HTTP de portales: contraseña y cookie
comercial, selección y PIN del vendedor, dashboard, logout, acceso de analista,
restricciones por rol y consulta del crédito/calendario de un cliente de prueba.

Evidencias locales del worktree (fuera de los archivos de aplicación):
`output/public-site/qa-report.json`,
`output/public-site/qa-portals-http-result.json`,
`output/public-site/desktop.png` y `output/public-site/mobile.png`.

La vista previa local utiliza datos de prueba. Se enviaron dos correos reales a comercial@finserpay.com.
La publicación requiere comprobación final en el dominio real.
