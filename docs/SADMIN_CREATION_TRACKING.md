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

## Importación CSV y crédito individual histórico

Ambas pestañas de **Créditos masivos** requieren **Número de crédito en SADMIN**.
La columna se añade al final de la plantilla para conservar el orden de los campos
anteriores; los CSV anteriores deben completarla. Es texto, conserva ceros
iniciales, admite hasta 80 caracteres y aparece en la vista previa y el resultado
CSV. La API rechaza valores vacíos, caracteres de control y números duplicados
(incluidos otros créditos y repeticiones dentro del mismo archivo, sin distinguir
mayúsculas). También rechaza cédulas repetidas o con cualquier crédito existente
en FINSER PAY, incluso pagado, sin importar aliado o IMEI. Los errores se muestran
por fila y una sola fila inválida impide crear todo el lote.

Antes de crear, el administrador central confirma explícitamente que los créditos,
codeudores y números **ya existen y fueron verificados en SADMIN**. Esta es una
confirmación humana auditada; no se envían solicitudes a una API externa.
La API exige `sadminConfirmed: true` y un `requestId` UUID por operación.

El crédito y su `CreditSadminRegistration` se guardan en la misma transacción,
con las tres verificaciones, número y fecha de confirmación; `CreditSadminEvent`
registra al administrador y el origen `ADMIN_EXISTING_SADMIN`. El snapshot
conserva el número junto con los datos del cliente, lote y recibo de importación.
El listado SADMIN y la solicitud de origen CREDIT del muro de Solicitudes ya
consultan esa relación por `creditoId`: muestran el número confirmado sin crear
otro borrador ni cambiar las reglas de aprobación o el estado financiero.

La transacción vuelve a validar después de bloquear las cédulas con el mismo
bloqueo usado en la creación ordinaria. El índice único vigente de SADMIN protege
el número ante carreras. Si falla el crédito, registro o auditoría, todo el lote
se revierte. **Reintentar guardado** conserva el identificador de operación:
si el servidor había confirmado el lote pero se perdió la respuesta, devuelve el
recibo original sin volver a crear créditos. Reutilizar ese identificador con
otros datos o usuario devuelve conflicto. La interfaz sólo muestra éxito después
de recibir `commit: true`; los rechazos posteriores a la vista previa vuelven a
mostrar los errores por fila.

Pruebas: `node --test tests/mass-credit-sadmin.test.mjs tests/mass-credit-sadmin-ui.test.mjs`.
La integración PostgreSQL requiere `MASS_CREDIT_TEST_DATABASE_URL` en loopback y
base exclusiva `mass_credit_sadmin_test`. Cubre ambos modos, consulta real del
listado SADMIN, auditoría, cédulas y números duplicados, fallos transaccionales,
reintentos y concurrencia. No debe apuntar a una base operativa.


### IMEI al preparar la plantilla CSV en Excel

La carga operativa continúa aceptando CSV. Como CSV no almacena el tipo Texto de
una columna, abrirlo directamente en Excel puede mostrar o guardar un IMEI como
`1E+15`. Para editar en Excel se descarga **Plantilla Excel para CSV**: IMEI,
cédula, teléfono, fechas y número SADMIN están preformateados como Texto hasta
la fila 251. El operador reemplaza el ejemplo, verifica los 15 dígitos del IMEI,
guarda una copia como **CSV UTF-8** y sube ese `.csv` directamente, sin volver a
abrirlo en Excel. La plantilla CSV original sigue disponible para editores que
conserven texto sin convertirlo.

La vista previa muestra el IMEI completo de cada fila. La API conserva sus 15
dígitos exactamente y rechaza por fila la notación científica, letras, separadores,
longitudes distintas de 15 o datos vacíos; ya no recorta dígitos sobrantes ni
reconstruye números abreviados. Un CSV dañado debe corregirse con el IMEI de la
fuente original antes de crear el lote. Las mismas reglas se aplican al crédito
individual. Las validaciones restantes de crédito y SADMIN no cambian.

Pruebas: `node --experimental-strip-types --test tests/mass-credit-*.test.mjs`
con `MASS_CREDIT_TEST_DATABASE_URL` solo sobre una base PostgreSQL local y
exclusiva. Verifican ambos modos, Excel guardado y reabierto, CSV con ceros
iniciales, errores por fila y reversión de guardado.
