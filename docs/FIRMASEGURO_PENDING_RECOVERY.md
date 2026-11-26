# Recuperación administrativa de un envío incierto

`PendingSignatureRecovery` se integra en el paso Identidad y firma. El padre solo
lo habilita para el administrador central de FINSER PAY y una reserva `UNCERTAIN`
sin recibo ni identificador del proveedor. Los permisos y todas las condiciones
se vuelven a comprobar en el servidor; `canRecover` no autoriza una mutación.

La interfaz ofrece dos rutas. Si el administrador encuentra el proceso original,
puede aportar su UUID a `POST /api/creditos/borradores/{id}/firma-seguro/conciliar`.
El servidor verifica que corresponde al contrato antes de vincularlo. No se crea
ni reenvía una firma.

Si no logra localizarlo, debe registrar un motivo de 20 a 500 caracteres, confirmar
la revisión por cliente y folio, y aceptar que el resultado remoto sigue incierto.
La ausencia en una búsqueda o un error HTTP 502 no prueban que el proveedor no
haya creado un proceso. El diálogo final explica esa incertidumbre y el posible
duplicado antes de llamar a `POST /api/creditos/borradores/{id}/firma-seguro/recuperar`.
La recuperación prepara un único intento con el mismo folio y valores. El envío
posterior requiere la acción explícita Continuar el mismo envío por el administrador que preparó la recuperación.

Ambas rutas bloquean clics simultáneos y descartan respuestas de otra solicitud o
de un permiso revocado. Los fallos conservan lo introducido y muestran mensajes
operativos sin cuerpos ni errores internos del proveedor. Un timeout exige
actualizar el estado antes de repetir; no se reintenta automáticamente.

La presentación reutiliza Button, Input, ConfirmDialog y los tokens grafito,
porcelana, ámbar y rojo del sistema compartido. No acredita recepción de WhatsApp;
la aceptación de un proceso de firma y la entrega de su notificación son hechos
distintos.

Pruebas de interacción: `node --experimental-strip-types --test tests/pending-signature-recovery-ui.test.mjs`.

## Intento adicional pagado después de un fallo por saldo

El operador central puede preparar un único intento pagado adicional cuando los
dos intentos anteriores respondieron con el error específico de saldo insuficiente,
sin identificador remoto, recibo ni proceso asociado. Requiere revisar el portal,
registrar la autorización expresa del nuevo cobro y aceptar que el resultado remoto
anterior sigue siendo desconocido. La búsqueda vacía no se registra como prueba
de ausencia ni los errores históricos se convierten en rechazos seguros.

`scripts/authorize-paid-firmaseguro-draft-retry.mjs --input-file FILE` verifica
las condiciones sin modificar datos. El JSON debe contener `draftId`, `dispatchId`
del segundo intento, `actorId`, `reason`, `providerReviewConfirmed`,
`remoteOutcomeUnknownAccepted` y `newChargeAccepted`; las tres confirmaciones deben
ser verdaderas. El administrador debe estar activo y pertenecer a la central.
El campo opcional `expectedFingerprint` permite fijar la huella obtenida en una
verificación previa y detener la operación si el expediente cambió.

`--apply` reserva un nuevo envío con el PDF, folio, sello y contactos conservados;
`--send` requiere además `--apply` y ejecuta el ledger normal una sola vez. El
esquema conserva ambas autorizaciones inmutables y limita este permiso a un intento
adicional. Los replays devuelven la misma reserva y no crean una cadena de reenvíos.
El saldo se comprueba antes de reservar y de enviar; un fallo posterior al POST
continúa requiriendo conciliación, sin un reintento automático.
