# Operación del CRM de Atención

## Fase operativa

La fase de bandeja, lecturas por usuario, agenda y plantillas manuales se desplegó el 30 de octubre de 2026, con once tablas de Atención. El despliegue Railway `2806377b-7260-4ba6-9af6-bceb820f3c12`, commit `463fe910e5cac6ca9a2a712684665a1426f5d019`, confirmó ese estado base. La ampliación de plantillas de cartera descrita aquí requiere su propia validación de despliegue. Mantiene el acceso global de administración central y el acceso del analista nominal únicamente a sus chats asignados.

La interfaz organiza la bandeja y el chat con una disposición similar a WhatsApp Web: lista lateral, historial y editor de respuesta, con la ficha y las gestiones en paneles secundarios. Conserva la navegación, los componentes y los colores compartidos de FINSER PAY. Las actualizaciones conservan la selección, los borradores y la posición de lectura.

## Bandeja, lecturas y espera

Los filtros No leídos, Sin responder y, para administración central, Sin asignar se combinan con la búsqueda y las etiquetas. Se conservan Todas, Mías, Pendientes y Finalizadas. Solo se ofrecen etiquetas de conversaciones accesibles al usuario, incluida `FINSERPAY` cuando la clasificación financiera la acredita.

No leído es un estado propio de cada usuario nominal. Abrir una conversación no basta: la interfaz confirma los identificadores entrantes que ha cargado cuando el chat está visible y desplazado hasta el final. El servidor valida esos mensajes y el acceso actual; un mensaje que llega simultáneamente queda sin leer si no estaba incluido en la confirmación. Leer un chat no lo modifica para otro analista, no cambia su versión de negocio ni envía un recibo de lectura a WhatsApp.

La confirmación admite hasta 500 mensajes entrantes observados. El histórico anterior que no esté cargado no se marca automáticamente: puede seguir contando como no leído. No se presume una lectura inicial ni se marca todo el historial por la hora del navegador.

Sin responder significa que existe una entrada posterior a la última salida acreditada. La espera comienza en la primera entrada todavía sin respuesta; una salida pendiente, fallida o incierta no la elimina. Una respuesta aceptada por Meta o una salida registrada en el histórico sí cuenta como respuesta, incluida la automatizada. Leer o añadir una nota no responde al cliente. Se muestra el tiempo transcurrido sin imponer un umbral de servicio ficticio.

## Agenda y avisos internos

La Agenda reúne las tareas pendientes de los chats permitidos: Hoy, Vencidas, Próximas y Todas. Los cortes usan el día calendario de `America/Bogota`; Vencidas corresponde a días anteriores y Todas incluye las tareas sin fecha. Los totales siguen el mismo alcance de acceso y la lista se pagina en grupos de cuarenta.

Desde cada tarea se puede abrir el chat o completar el seguimiento. El servidor vuelve a comprobar la asignación y la versión del chat antes de guardar. El aviso de tareas vencidas o para hoy aparece dentro del CRM; esta fase no envía notificaciones externas ni mensajes automáticos al cliente.

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

## Plantillas manuales de WhatsApp

El botón Plantilla consulta las definiciones aprobadas en la cuenta Meta de esta línea. Permite completar variables posicionales de texto, consultar la vista previa y confirmar expresamente el destinatario y el mensaje. Admite cuerpo y encabezado de texto, pie, botones de respuesta rápida y enlaces estáticos o con un sufijo validado. Las estructuras no compatibles se muestran deshabilitadas con su motivo.

Una plantilla aprobada puede iniciar el contacto fuera de la ventana de 24 horas, sin habilitar por ello texto libre. Un chat histórico sin vínculo Meta requiere un teléfono exacto y único, sin vínculo contradictorio, y confirmación del operador. Se conservan el responsable, el cierre y el historial; el envío no inventa un mensaje entrante ni amplía la ventana de respuesta.

Las plantillas de cartera se habilitan según el crédito verificado y su calendario: `2dias` dos días antes, `1_dia_falta` el día anterior, `hoyvence` y `fechap` el día del vencimiento. `data` conserva la regla existente del día exacto veinte de mora y muestra los créditos incluidos en el aviso. El analista selecciona el crédito y revisa el mensaje; el servidor completa el nombre, la empresa y la fecha, sin aceptar parámetros financieros escritos por el navegador. Se comprueban pagos, prórrogas, protecciones, horario de contacto y registros anteriores de envío. Si cambian los datos tras la revisión, se exige revisar de nuevo.

Los recordatorios manuales comparten el registro de envíos con las campañas, incluido el mismo registro para `hoyvence` y `fechap`. El encabezado de imagen de `2dias` usa el recurso configurado para esa plantilla; no admite una imagen o URL elegida por el operador. Las plantillas de bienvenida y liquidaciones permanecen en sus procesos correspondientes. `cuotavencida` y `vencido` afirman que existe una restricción programada dentro de treinta minutos: estar en mora por sí solo no permite enviarlas ni programa un bloqueo. Tampoco se habilitan autenticación, variables con nombre ni formatos no admitidos. El catálogo y la revisión de la definición se comprueban de nuevo antes de enviar.

Cada confirmación conserva una intención persistida con UUID y contenido fijo. Un resultado incierto se consulta sin repetir el envío; una solicitud ausente se cancela de forma persistente antes de preparar una sustituta. Cambiar el mensaje o reutilizar el UUID con otro contenido produce conflicto. Estas reglas comparten el outbox humano y sus comprobaciones de permisos, destinatario e indicadores de Meta. Véase [la operación técnica de Meta](ATENCION_META.md#plantillas-manuales-aprobadas).

## Actualización y acceso

Meta sigue recibiendo mensajes y archivos en el número empresarial actual. La interfaz conserva el historial que el analista está leyendo y sus borradores cuando se actualiza. El estado de entrega proviene de los eventos de WhatsApp.

La conexión en tiempo real usa eventos del servidor y notificaciones transaccionales de PostgreSQL: los mensajes, sus estados y las asignaciones invalidan la bandeja cuando se confirma el cambio. Cada conexión revalida el usuario y su alcance. Si se interrumpe, se reconecta y vuelve a consultar; la actualización periódica queda como respaldo. No hace falta importar Dapta para recibir los nuevos mensajes de Meta.

El instalador prepara los tres disparadores de actualización mediante `scripts/ensure-atencion-schema.mjs`. Las consultas y las entradas de auditoría no producen notificaciones. Una confirmación de lectura que añade mensajes genera un único aviso dirigido al mismo usuario nominal; repetirla sin cambios no genera otro aviso ni otra entrada de lectura en auditoría. Un único canal PostgreSQL por proceso sirve a las conexiones autorizadas; los eventos que llegan al navegador no contienen nombres, teléfonos ni mensajes.

No se cambia el número ni el proveedor. Diana permanece pausada conforme a la operación autorizada; esta entrega no la reactiva.
