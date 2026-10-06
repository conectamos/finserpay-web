# Mesa del analista: cartera y excepciones

La cuenta nominal `ANALISTA_APROBACION` de FINSER PAY puede consultar y gestionar
cartera en mora en `/dashboard/aprobaciones/cartera-mora`, y enviar solicitudes
en `/dashboard/aprobaciones/excepciones-mora`. Los enlaces de aprobación no
conceden estas facultades. El servidor revalida usuario, sede, aliado y rol
activo antes de cada escritura.

## Gestiones y soportes

El saldo vencido y los días de mora se calculan con el plan de pagos vigente,
abonos no anulados y estado de liquidación. No se usa un saldo estimado ni se
modifica el calendario contractual. Las gestiones exigen acción, fecha y hora,
responsable activo, resultado, comentario y fecha posterior de seguimiento.
El actor que registra la gestión y el responsable se guardan por separado.

`CreditMoraManagementEvent` y `CreditMoraSupport` son append-only: PostgreSQL
rechaza UPDATE, DELETE y TRUNCATE. Los soportes son PDF/JPG/PNG válidos de máximo
10 MB y siempre pertenecen a una gestión o excepción existente del mismo
crédito. Descargarlos exige cuenta nominal autorizada; no tienen URL pública.
Los envíos idempotentes conservan un único evento o archivo al reintentar.

## Solicitudes de excepción y prórroga

El analista registra motivo, observación, compromiso de pago y vencimiento, y
envía a revisión. Puede agregar observaciones y soportes. Solo ADMIN central
puede aprobar o rechazar; ambos actos requieren motivo y versión vigente.
Las decisiones y el vencimiento automático tienen historial de usuario,
fecha, hora y resultado, y no se pueden borrar.

La condición se verifica con abonos reales del crédito desde la aprobación de la
solicitud hasta la fecha comprometida. Una excepción aprobada cuyo plazo venció
sin cumplir el compromiso bloquea una nueva solicitud por 20 días calendario
completos, contados desde el día siguiente al vencimiento. Si vence el 01,
los días 02–21 quedan bloqueados y la nueva solicitud se habilita el 22.

Mensaje del bloqueo:

> Este crédito tuvo una excepción vencida. Podrá solicitar una nueva excepción a partir del [fecha habilitada].

El permiso explícito `MORA_COOLDOWN_BYPASS`, vigente para un ADMIN central,
permite omitir ese enfriamiento con motivo obligatorio. No se concede al
analista ni se asigna automáticamente por tener rol administrativo.

Una prórroga se vincula a la cuota regular pendiente más antigua. Solo se
solicita después de su fecha 02 o 17 y hasta cuatro días calendario después:
06 y 21 respectivamente. El formulario recibe la fecha máxima del servidor;
la creación y aprobación vuelven a comprobarla. Al superar esa fecha, no se
admiten nuevas prórrogas para esa cuota. La autorización es específica del
crédito y no cambia valor de venta, inicial, monto, plazo, cuota ni primer pago.

Al aprobar, el servidor confirma primero la decisión y luego sincroniza únicamente ese
crédito con Equality. Si el desbloqueo inmediato falla, la aprobación y su historial se
conservan, la respuesta informa el fallo operativo sin exponer datos del proveedor y la
sincronización automática puede reintentarlo.

## Despliegue y pruebas

`railway-predeploy.mjs` instala de forma aditiva el esquema de gestiones/soportes
y después el de solicitudes/eventos/permisos. No elimina tablas ni registros
anteriores. El flujo antiguo por cédula conserva consulta de autorizaciones
históricas; las nuevas solicitudes deben pasar por el módulo por crédito.

Ejecutar `npm run test:mora-analista`, `npm run test:aprobaciones`, las pruebas de
SADMIN, TypeScript y build. Las pruebas de PostgreSQL embebido usan únicamente
fixtures sintéticos; no contactan clientes ni proveedores de bloqueo o firma.
