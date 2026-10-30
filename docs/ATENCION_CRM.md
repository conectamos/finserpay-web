# Operación del CRM de Atención

## Contactos y créditos

- La etiqueta automática `FINSERPAY` incluye créditos vigentes y pagados. Se calcula en el servidor a partir de los créditos registrados y del teléfono exacto del chat; no es una etiqueta editable.
- Las etiquetas manuales se guardan en el contacto para clasificar y dar seguimiento. Se permiten hasta ocho, de cuarenta caracteres cada una.
- Un teléfono compartido por distintas identidades no vincula créditos automáticamente. Administración debe verificar la coincidencia y seleccionar el vínculo. Un vínculo cuyo teléfono ya no coincide queda sin verificar.
- Si la misma persona tiene varios créditos, el analista selecciona el crédito antes de gestionar una prórroga o un recibo.

## Prórrogas desde el chat

El analista nominal puede conceder una prórroga únicamente desde un chat que tenga asignado, para un crédito cuya identidad esté verificada. Administración usa la misma regla limitada en esta vista.

Los días cuentan desde el vencimiento de la cuota pendiente más antigua: del 02 hasta el 06, o del 17 hasta el 21. Solo aparecen los plazos de uno a cuatro días que siguen vigentes. La operación requiere motivo, observación y un compromiso de pago real; antes de guardar se presenta la fecha resultante para confirmar.

El servidor vuelve a comprobar permisos, identidad, pagos y calendario dentro de una transacción. Guarda al analista real como autor y aprobador, junto con el historial. No modifica los permisos generales de administración de créditos.

Ante una interrupción, la interfaz conserva la solicitud para consultar su resultado sin duplicar la prórroga. La actualización del estado del equipo se ejecuta después del registro; su eventual fallo se informa por separado.

## Último recibo

La ficha muestra el último pago activo, no anulado, ordenado por fecha de pago e identificador. Admite créditos ya pagados. El recibo se genera en el servidor, con documento enmascarado y los desgloses de capital o conciliación registrados cuando corresponden.

El analista puede abrir el PDF privado y confirmar el envío al mismo teléfono del chat. Se revalida el crédito y el último pago antes de despachar. Un envío pendiente de confirmación se consulta antes de intentar otro; el outbox impide repetir una solicitud aceptada. El comprobante confirma el pago registrado y no sustituye el certificado de paz y salvo.

## Audios y emojis

El editor permite insertar emojis, adjuntar audios compatibles y grabar hasta cinco minutos. El micrófono solo se activa tras pulsar Grabar audio y permitirlo en el navegador. Detener permite escuchar, descartar o adjuntar; adjuntar todavía requiere pulsar Enviar.

Las grabaciones WebM se convierten en memoria a OGG/Opus mediante FFmpeg instalado en la imagen de producción. La conversión está autenticada y limitada a ocho MB, dos procesos simultáneos por instancia y cuarenta y cinco segundos. No usa archivos públicos ni servicios externos. Cambiar de chat o perder el permiso de respuesta cancela la captura.

Los audios se envían sin texto adjunto. El texto que se está preparando se conserva y se envía por separado.

## Actualización y acceso

Meta sigue recibiendo mensajes y archivos en el número empresarial actual. La interfaz conserva el historial que el analista está leyendo y sus borradores cuando se actualiza. El estado de entrega proviene de los eventos de WhatsApp.

La conexión en tiempo real usa eventos del servidor y notificaciones transaccionales de PostgreSQL: los mensajes, sus estados y las asignaciones invalidan la bandeja cuando se confirma el cambio. Cada conexión revalida el usuario y su alcance. Si se interrumpe, se reconecta y vuelve a consultar; la actualización periódica queda como respaldo. No hace falta importar Dapta para recibir los nuevos mensajes de Meta.

El despliegue instala los tres disparadores de actualización mediante `scripts/ensure-atencion-schema.mjs`. Las consultas y las entradas de auditoría no producen notificaciones. Un único canal PostgreSQL por proceso sirve a las conexiones autorizadas; los eventos que llegan al navegador no contienen nombres, teléfonos ni mensajes.

No se cambia el número ni el proveedor. Diana permanece pausada conforme a la operación autorizada; esta entrega no la reactiva.
