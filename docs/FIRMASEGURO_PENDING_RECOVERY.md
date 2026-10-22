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
