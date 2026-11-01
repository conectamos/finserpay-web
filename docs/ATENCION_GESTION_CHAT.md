# Gestión de solicitudes dentro del chat

Las bandejas de **Atención → Enrolamientos** y **Atención → Aprobaciones** permiten continuar el trámite en la conversación interna del asesor. Cada solicitud está vinculada a una operación existente; no se crean clientes, créditos ni mensajes de WhatsApp simulados.

## Enrolamiento iPhone

La gestión usa exclusivamente el borrador de iPhone vinculado a la solicitud. Consulta los datos actuales y conserva las validaciones del módulo existente: etapa de enrolamiento y entrega, vigencia de la solicitud, evaluación autorizada, identidad verificada y firma vigente con la misma cédula e IMEI.

El analista confirma las cuatro verificaciones que ya utiliza el portal:

- Bloqueo de activación.
- ABM.
- Bloqueo del dispositivo.
- Desbloqueo del dispositivo.

El servidor exige las cuatro confirmaciones y las guarda en la trazabilidad del caso. La autorización canónica conserva su versión e integridad originales. Si ya existe una autorización válida, **Registrar autorización y finalizar** conserva el autor y la fecha originales, sin registrar pruebas nuevas como si se hubieran realizado nuevamente.

Solo una autorización vigente permite finalizar el enrolamiento. La autorización, el historial de gestión, el mensaje interno de resultado y el aviso al asesor se guardan en una misma transacción.

## Aprobaciones: llamada de bienvenida

Esta bandeja gestiona la llamada solicitada por el asesor; no cambia las reglas de aprobación financiera del crédito.

**Gestionar bienvenida** abre el muro de aprobaciones del crédito vinculado en una pestaña nueva, con sus datos, evidencias, contrato e historial reales. El chat conserva el panel de gestión para registrar el resultado al regresar. El enlace solo está disponible cuando la persona puede gestionar el caso y el identificador del crédito coincide con la ruta canónica del expediente; no se sustituye por una búsqueda ni se abre otro crédito. Si falta ese vínculo, se indica la limitación y se mantiene el panel de seguimiento. Abrir el muro no inicia llamadas ni aprueba el crédito.

El analista selecciona la modalidad humana o Dapta. En modalidad humana puede cargar y consultar la grabación mediante los controles existentes. La finalización exige la evidencia que corresponda según la regla vigente del crédito.

En modalidad Dapta se utiliza el servicio de voz ya configurado. Solicitar una llamada es una acción explícita; abrir la ficha o consultar el resultado no inicia llamadas. Una solicitud de llamada pendiente o de resultado incierto no se registra como una bienvenida realizada.

El resultado y la observación quedan en el historial de la conversación. **Contacto humano** finaliza la bienvenida; **no autoriza** cierra la gestión sin afirmar que la bienvenida se realizó. **No contestó** y **por confirmar** mantienen el caso en revisión para darle continuidad. Cuando el resultado proviene de Dapta, debe coincidir con una llamada terminada y su evidencia vigente.

El resultado humano también se consulta antes de enviar nuevas llamadas: **no autoriza** bloquea las llamadas posteriores y **contacto humano** evita repetir automáticamente la bienvenida. Se conserva como evidencia humana del caso; no se crea una llamada ficticia de Dapta ni se cambia el resultado de llamadas que ya pudieron salir.

Al llegar al muro desde esa acción aparece **Chat con asesor**, una burbuja para reabrir la conversación vinculada en el mismo expediente. **Minimizar chat** vuelve al muro sin desmontar el borrador ni el archivo pendiente; al reabrir se revalidan los permisos y se actualiza el historial real. Desde este chat la gestión de bienvenida abre su formulario sin crear otra pestaña del muro. La burbuja no crea solicitudes: usa el identificador autorizado del enlace y solo aparece mientras se consulta ese mismo crédito con acceso nominal. Las solicitudes finalizadas mantienen su historial de solo lectura.

## Permisos y continuidad

Solo administración central y el analista actualmente asignado pueden gestionar el caso. El servidor comprueba nuevamente la asignación, la operación, el asesor titular, la sede y la identidad al guardar. Si cambiaron, solicita actualizar en lugar de aplicar el resultado a otro expediente. Los reintentos del mismo envío recuperan el resultado guardado y evitan repetir la autorización o la llamada.

El selector general de estado no permite marcar **Finalizada** sin completar la gestión correspondiente. Las respuestas, soportes y notas existentes permanecen disponibles; las notas internas mantienen su visibilidad restringida.

## Configuración y prueba

Esta ampliación reutiliza las tablas y credenciales existentes. No requiere migrar el número de WhatsApp ni cambiar Meta o Dapta. Enrolamiento depende de la configuración existente `IPHONE_ENROLLMENT_*`; las llamadas automáticas dependen de la configuración de voz Dapta ya utilizada por la plataforma. Si un servicio no está disponible, se muestra el motivo y la conversación puede continuar.

Antes de trasladar la operación, probar con una solicitud autorizada de iPhone y otra de bienvenida: asignar el caso, intercambiar un mensaje, revisar los soportes, comprobar los estados y verificar que el asesor recibe el resultado. Autorizar un enrolamiento o iniciar una llamada real requiere la acción explícita del analista sobre el caso correcto; las pruebas automáticas usan datos de prueba y no llaman ni autorizan operaciones de producción.
