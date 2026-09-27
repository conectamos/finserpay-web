# Autorización de segundo crédito

El administrador central entra a **Parámetros de crédito → Segundo crédito**, busca la cédula exacta e ingresa el motivo para autorizar o revocar. La búsqueda se envía en el cuerpo de una petición; no hay un listado general ni cédulas en la URL.

Sin autorización, la venta nueva continúa bloqueada si el cliente tiene saldo pendiente. Una autorización activa permite hasta **dos créditos con saldo pendiente** para esa cédula; nunca permite un tercero vigente. Los créditos anulados y los saldados no cuentan como vigentes para este límite. El permiso continúa hasta que el administrador lo revoque.

La carga CSV y su formulario individual consultan la misma autorización al validar y vuelven a comprobarla dentro de la transacción que crea el crédito. Las cédulas repetidas dentro de un mismo archivo siguen siendo errores por fila. La restricción histórica de no importar una cédula ya registrada se conserva cuando no hay una autorización activa.

La autorización no modifica capital, cuota, política financiera, calendario, evaluaciones, aprobación, firma, lista negra, validación del equipo ni confirmación SADMIN. La autorización antigua `permiteMultiplesCreditos` no se reactiva ni concede permisos automáticamente.

Cada cambio registra usuario, fecha, motivo y versión. Un crédito creado mediante esta excepción conserva evidencia de la autorización utilizada. La autorización y la creación comparten el bloqueo de documento para impedir que solicitudes simultáneas excedan el límite o usen un permiso revocado antes de finalizar.
