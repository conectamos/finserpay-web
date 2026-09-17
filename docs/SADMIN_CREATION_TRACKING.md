# Creación en SADMIN

El botón **Creación SADMIN**, disponible en el muro de aprobaciones administrativo
y en su enlace compartido, abre la cartera completa desde el inicio de la operación.
Incluye históricos, importaciones, créditos centrales y pagados; excluye estados
ANULADO, ANULADA, CANCELADO y CANCELADA. Este alcance fue solicitado expresamente
para este módulo y no cambia las colas de revisión documental.

La tabla consulta 20 registros por página y los ordena por fecha del crédito e ID
descendentes. La búsqueda acepta cliente, cédula, folio, aliado o número de SADMIN.
Los valores, saldos y tasas usan los datos contractuales y los cálculos de Cartera.

Cada crédito conserva las verificaciones **CODEUDOR CREADO**, **CRÉDITO CREADO** y
**NÚMERO DE CRÉDITO**, además del número real asignado en SADMIN. Este último es
texto de hasta 80 caracteres, conserva ceros iniciales y debe ser único. El estado
**CREADO SADMIN** requiere las tres verificaciones y un número guardado. Cambiar
el número desmarca su verificación; desmarcar cualquier casilla deja el seguimiento
pendiente de nuevo. No se crean operaciones en un servicio externo.

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
