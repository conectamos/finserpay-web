# Datos del cliente — Nueva venta

Implementado sobre `origin/main` en `95c252180f01bbd9ee1ef494f159d13cfb3459e5`.

El paso conserva el encabezado y la navegación existente. `CustomerDetailsForm`
presenta los tres bloques en una sola superficie y usa los controles y tokens
compartidos. La mascota es un PNG independiente con animación CSS que respeta
`prefers-reduced-motion`.

Los bloques se habilitan tras completar y salir de un campo/bloque; no se
desmonta el campo que recibe foco ni se fuerza desplazamiento. La validez se
recalcula inmediatamente para bloquear avances tras una corrección. Los valores
viven en el formulario principal, por lo que contraer o bloquear conserva datos.
La recuperación explícita del borrador reinicia la vista en el primer pendiente.

La identidad y la oferta proceden de la consulta guardada. El nombre íntegro no
se divide. La edición de componentes conserva las restricciones existentes:
primer apellido, tipo y número de documento protegidos. Las correcciones guardan
original, anterior, resultado, usuario y fecha; un bloqueo transaccional evita
auditorías duplicadas por solicitudes concurrentes idénticas.

`ADVANCE_CLIENT` valida los datos en el servidor antes de persistir el avance.
El servidor también valida intentos de saltar a pasos nuevos sin esta acción.
Un autoguardado incompleto puede conservar una corrección sin autorizar avance.
Cancelar ofrece guardar y salir; Limpiar requiere confirmación y conserva el
borrador ya guardado. Las protecciones de solicitudes y envíos existentes siguen
en uso.

## Verificación

- `npm run build`: compilación de producción aprobada con una URL de base de
  datos local ficticia, sin consultas a servicios reales.
- `npx tsc --noEmit`: aprobado.
- 88 pruebas dirigidas: validación cliente, API de avance, teléfonos, identidad,
  auditoría concurrente, navegación y recuperación de solicitudes.
- Navegador Chromium con el componente real y datos ficticios: progresión,
  foco, bloqueo, correcciones, borradores y anchos 1440, 390 y 320 px.

El script reproducible es `tests/customer-details-browser.cjs`. Requiere
Playwright y Chrome/Chromium disponibles; admite `QA_PLAYWRIGHT_MODULE_PATH` y
`QA_CHROME_PATH`. Usa sólo recursos interceptados de localhost; no accede a
DataCrédito ni a bases de datos. Guarda capturas y resultados en
`output/customer-details/`.
