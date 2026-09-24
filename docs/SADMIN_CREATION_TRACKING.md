# Creación en SADMIN

El botón **Creación SADMIN**, disponible en el muro de aprobaciones administrativo
y en su enlace compartido, abre la cartera completa desde el inicio de la operación.
Incluye históricos, importaciones, créditos centrales y pagados; excluye estados
ANULADO, ANULADA, CANCELADO y CANCELADA. Este alcance fue solicitado expresamente
para este módulo y no cambia las colas de revisión documental.

La tabla consulta 20 registros por página y los ordena por fecha del crédito e ID
descendentes. La búsqueda acepta cliente, cédula, folio, aliado o número de SADMIN.
Los valores, saldos y tasas usan los datos contractuales y los cálculos de Cartera.

Las pestañas **Todos**, **Pendientes** y **Creados** filtran el conjunto completo en
el servidor antes de paginar. La búsqueda activa se conserva al cambiar de pestaña
y la navegación vuelve a la primera página. Los conteos `all`, `pending` y
`created` corresponden al resultado de la búsqueda sin limitarse a los 20
registros visibles; por eso permiten conocer cuántos créditos hay en cada estado
antes de abrirlos. La API `GET /api/aprobaciones/sadmin` acepta
`status=all|pending|created`, usa `all` cuando el parámetro está ausente o vacío
y responde `INVALID_SADMIN_STATUS` con estado HTTP 400 ante cualquier otro valor.

Cada crédito conserva las verificaciones **CODEUDOR CREADO**, **CRÉDITO CREADO** y
**NÚMERO DE CRÉDITO**, además del número real asignado en SADMIN. Este último es
texto de hasta 80 caracteres, conserva ceros iniciales y debe ser único. El estado
**CREADO SADMIN** requiere las tres verificaciones y un número guardado. Cambiar
el número desmarca su verificación; desmarcar cualquier casilla deja el seguimiento
pendiente de nuevo. No se crean operaciones en un servicio externo.

Cuando una verificación mueve un registro fuera del filtro activo, la tabla vuelve
a consultar esa vista para actualizar filas, conteos y paginación. Los filtros se
bloquean mientras exista un número sin guardar o una escritura en curso, de modo
que el operador no pierda cambios al cambiar de pestaña.

Una vez guardado y confirmado el número, se usa como número principal visible en
Cartera, reportes, exportaciones y consultas. El campo `Credito.folio` no se
renombra: permanece como referencia contractual e interna de FirmaSeguro,
integraciones, rutas y recibos. Las respuestas añaden `numeroCreditoVisible` y
las búsquedas autorizadas aceptan tanto el número confirmado como el folio
original. Los números aún sin confirmar no sustituyen el folio. Editar el número
requiere confirmarlo nuevamente para mostrar la nueva referencia.

La tabla principal de SADMIN muestra únicamente número del crédito, fecha y
estado. El bloque completo es un botón que despliega datos del cliente, equipo,
origen, valores, tasas, pagos, saldos y las verificaciones SADMIN. El folio original
y el formulario de registro se consultan dentro de ese detalle; cerrar y volver
a abrir conserva cualquier número pendiente de guardar.

El seguimiento se almacena en CreditSadminRegistration con versión de concurrencia
y eventos inmutables en CreditSadminEvent. No modifica el estado financiero del
crédito ni su aprobación documental. Las API reutilizan los permisos de aprobación,
validación de sesión compartida y protección de origen; cada mutación bloquea la
fila del crédito y valida la versión antes de registrar el cambio y su autor.

El predeploy de Railway instala el esquema idempotente después de los esquemas
de aprobaciones. Pruebas PostgreSQL aisladas se ejecutan con
CREDIT_SADMIN_SCHEMA_TEST_DATABASE_URL (base sadmin_test) y
CREDIT_SADMIN_SERVICE_TEST_DATABASE_URL (base sadmin_service_test), exclusivamente
en loopback. Los datos sintéticos y el clúster local en tmp no se publican.

## Exportación a Excel

El botón **Exportar Excel** descarga todos los créditos que coinciden con la
búsqueda y la pestaña activas. La exportación no se limita a la página visible:
`GET /api/aprobaciones/sadmin/export?q=<búsqueda>&status=all|pending|created`
repite en el servidor los mismos criterios de alcance, búsqueda, estado y orden
de la tabla. El archivo se genera sobre una lectura consistente y no modifica
créditos, verificaciones ni eventos de auditoría.

El libro `.xlsx` contiene una hoja **Creación SADMIN** con datos del cliente,
equipo y origen; valores y condiciones del plan; tasas, pagos y saldos; y el
estado, número, verificaciones y fechas de SADMIN. Cédula, teléfono, IMEI, folio
y número SADMIN se escriben como texto para conservar ceros iniciales y evitar
que contenido que empiece por `=`, `+`, `-` o `@` se interprete como fórmula.
Los importes, cantidades, porcentajes y fechas mantienen tipos nativos de Excel.

La ruta admite los mismos actores personales y accesos compartidos vigentes del
módulo. Responde con caché privada deshabilitada, `nosniff`, MIME de XLSX y una
descarga con nombre `creacion-sadmin-{todos|pendientes|creados}-AAAA-MM-DD.xlsx`.
Si el resultado supera **2.000 registros**, responde HTTP 413 con el código
`SADMIN_EXPORT_TOO_LARGE`; nunca entrega un archivo truncado. Un resultado vacío
produce un libro válido con sus encabezados.

Cada proceso genera una sola exportación SADMIN a la vez para mantener acotado el
uso de memoria. La exclusión se adquiere después de autenticar al solicitante y
cubre la consulta y la construcción completa del XLSX. Otro intento autorizado
durante ese intervalo recibe HTTP 429 con el código `SADMIN_EXPORT_BUSY`; el turno
se libera siempre al terminar, incluso si falla la consulta o la serialización.

La interfaz bloquea la exportación mientras carga, guarda verificaciones o existe
un número SADMIN sin guardar. Durante la generación muestra **Generando Excel...**
y conserva en pantalla la tabla, la búsqueda, la pestaña y la página actuales.
Los errores de descarga se presentan junto a los controles sin borrar los datos
ya consultados.
