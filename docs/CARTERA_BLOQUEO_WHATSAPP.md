# BLOQUEO desde Cartera

El administrador central dispone de **Enviar BLOQUEO por WhatsApp** en Cartera.
Un clic crea el lote para todos los aliados y productos, con independencia de
los filtros de la pantalla. Abrir o actualizar la pantalla sólo consulta estado.

La mora se calcula con el plan vigente, abonos válidos y fecha de Colombia,
igual que en Cartera. Se requiere un día vencido o más, cuota pendiente y saldo
positivo; se excluyen pagados, anulados, paz y salvo, calendarios y móviles
inválidos. Sólo se utiliza el celular del titular, nunca referencias familiares.

BLOQUEO excluye al destinatario completo si cualquiera de sus créditos tiene una
prórroga o excepción aprobada vigente. Se conserva la protección heredada por
cédula. Se utiliza el reloj de la base de datos: una aprobación sin vencimiento
protege indefinidamente y una fecha de vencimiento protege hasta el final de ese
día en Colombia. Una solicitud pendiente, rechazada, cancelada, reemplazada o
vencida no constituye una protección activa.

La selección y la comprobación previa al envío aplican esa misma protección.
La comprobación final y el inicio de la petición HTTP se realizan manteniendo
los bloqueos de los créditos del titular, compartidos con las aprobaciones de
prórrogas. Si deja de ser elegible, se omite el evento y se conserva su historial.

La infraestructura de cola, auditoría, recibos y seguimiento es compartida con
Cuotavencida, con tablas, claves de idempotencia, variables privadas y trabajadores
independientes. Cada campaña admite un lote por día de Colombia. Repetir el clic
devuelve el lote existente. La cola continúa aunque se cierre Cartera y recupera
pendientes del día tras un reinicio. Los resultados inciertos no se reintentan
automáticamente para evitar duplicados; los pendientes de otro día se cancelan.

La plantilla existente `bloqueo` tiene ID
`79598d07-6e9e-4850-abd4-e59c22fc7f8a`, idioma `es`, cabecera de imagen y
ninguna variable. Se conserva su contenido aprobado. El flujo Dapta `VqIl9`,
**BLOQUEO — Envío manual desde Cartera**, utiliza el canal activo de Diana.
Recibe `telefono`, `nombre` y `event_id`; el nombre no se añade como variable de
una plantilla que no la tiene. Un recibo correlacionado identifica la aceptación
por el proveedor; no implica entrega ni lectura.

Configuración del servidor: `DAPTA_BLOQUEO_ENABLED=true` y
`DAPTA_BLOQUEO_WEBHOOK_URL` privada, nunca expuesta al navegador ni a Git.
El instalador existente de campañas prepara también `BloqueoWhatsAppBatch`,
`BloqueoWhatsAppEvent` y `BloqueoWhatsAppCoverage`; no elimina ni migra el historial
de Cuotavencida.

Este botón sólo envía la plantilla. No ejecuta comandos de bloqueo del equipo
ni cambia las otras campañas, recordatorios o llamadas.
