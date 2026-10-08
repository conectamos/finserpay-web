# Rediseño de Aprobaciones

La mesa usa una composición compartida de tres columnas: expedientes, revisión y gestión. Analistas nominales conservan filtros por aliado/fechas y accesos operativos dentro del expediente completo. Administradores mantienen sus accesos y gestión SADMIN. Los formularios de llamada, novedades, firma, corrección y confirmación reutilizan sus componentes y reglas existentes.

El detalle devuelve `numeroCreditoSadmin`, `imei` y `sedeNombre` desde el crédito y su registro SADMIN. El número externo nunca toma el folio como respaldo; la ausencia se muestra como PENDIENTE SADMIN. Folio, score, contactos y fechas siguen disponibles al expandir el expediente. Las imágenes originales conservan proporciones y acceso autenticado. Selección de documentos, formularios y visores se aíslan por crédito y revisión.

En Cartera en mora, el detalle devuelve `currentResponsible` de la sesión nominal. El formulario lo muestra como solo lectura y envía ese ID. El servicio revalida la cuenta en la transacción, rechaza `RESPONSIBLE_MISMATCH` para nuevas gestiones atribuidas a otros usuarios y guarda el nombre validado. Se mantienen historial e idempotencia de envíos previos.

Verificación: TypeScript sin errores; ESLint en los componentes editados; pruebas de servicios, bloqueo de aprobación, audio, firma, novedades, datos, permisos, identidad SADMIN y gestión de mora. Pruebas de navegador a 1672, 1024, 768, 390 y 320 px: composición, documentos originales, cambio de expediente, bloqueo/confirmación, contadores y aprobadas. Cartera: responsable de sesión ineditable y envío correcto aunque la gestión anterior perteneciera a otra persona.

Las capturas de QA usan datos sintéticos identificados como prueba. La aplicación continúa leyendo los endpoints reales. No se cambian registros operativos durante QA. La publicación se realiza mediante la rama main y el despliegue de producción de Railway.
