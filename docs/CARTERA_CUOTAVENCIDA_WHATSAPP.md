# Cuotavencida desde Cartera

El administrador central puede pulsar **Enviar Cuotavencida por WhatsApp** en
`/dashboard/cartera`. Ese clic crea un lote manual para todos los aliados y
productos, independiente de los filtros de la pantalla. No hay confirmación
adicional ni carga de Excel.

Se seleccionan los créditos con uno o más días vencidos según el plan vigente y
la fecha de Colombia, cuotas pendientes y saldo positivo. Se excluyen créditos
pagados, anulados, paz y salvo, calendarios inválidos y teléfonos no válidos.
También se excluyen las prórrogas y excepciones `APPROVED` vigentes, hasta el
final del día de vencimiento en Colombia, o sin vencimiento. La protección es
por crédito; no se extiende a otro crédito del mismo titular. Los acuerdos
heredados por cédula conservan su alcance por documento. Solicitudes pendientes,
rechazadas, canceladas, reemplazadas o vencidas no conceden esta protección.
El nombre y el celular provienen del cliente registrado en el crédito; no se
utilizan referencias familiares.

Los créditos de un mismo titular se agrupan en un solo mensaje. Cuando falta el
documento, se agrupan por el móvil registrado. Si dos titulares distintos
comparten el mismo número, se omite ese destino para no dirigir un saludo al
titular incorrecto. La selección recorre toda la cartera mediante paginación por
ID; no se limita a los registros visibles de la tabla.

## Envío y seguimiento

El lote queda guardado antes de responder al clic. Se procesa inmediatamente y
continúa en la cola interna cada 30 segundos, aunque se cierre la página. El
trabajador no crea campañas: únicamente procesa lotes iniciados por un usuario.
Un reinicio recupera el lote del día; los pendientes de días anteriores se
cancelan para evitar avisos atrasados.

El lote es único por día de Colombia. Repetir un clic, usar dos pestañas o repetir
una solicitud devuelve el mismo lote y no vuelve a enviar a sus destinatarios.
Antes de cada envío se vuelven a consultar el saldo, la mora y el contacto del
cliente. Si ya pagó o dejó de cumplir las condiciones, se omite ese envío.
Se vuelve a comprobar la protección por mora con el reloj de la base de datos,
bajo el mismo bloqueo de fila que utiliza su aprobación. El bloqueo se mantiene
hasta la petición HTTP, limitada a ocho segundos. Si el lote ya estaba creado,
el envío protegido queda `CANCELLED` con resultado `ACTIVE_MORA_PROTECTION`;
se conservan el evento, su cobertura y el historial, sin reintento automático.
Un titular con otro crédito elegible del mismo lote puede recibir el aviso por
ese otro crédito, sin agregar nuevos créditos al lote confirmado.

La pantalla muestra pendientes, aceptados por WhatsApp, fallidos, sin confirmar y
omitidos. **Aceptado** exige un recibo correlacionado del proveedor; no significa
que el mensaje haya sido entregado o leído. Un tiempo de espera o resultado
incierto queda registrado sin reintento automático.

## Configuración

- Plantilla existente `cuotavencida`, ID
  `3ace3379-49d0-4ba4-b2a4-f5b62e68b6a5`, idioma `es_AR`.
- Flujo Dapta `tKqW3`: **Cuotavencida — Envío manual desde Cartera**.
- Canal activo de Diana, WhatsApp v2.
- Entrada: `event_id` (UUID), `telefono` y `nombre` como texto.
- Variable de la plantilla: `var_1`, nombre del cliente.
- `DAPTA_CUOTAVENCIDA_ENABLED=true` y `DAPTA_CUOTAVENCIDA_WEBHOOK_URL` en el
  servidor. La URL privada nunca se entrega al navegador ni se incluye en Git.
- El predeploy instala las tablas `CuotaVencidaWhatsAppBatch`,
  `CuotaVencidaWhatsAppEvent` y `CuotaVencidaWhatsAppCoverage`.

Se conserva el texto aprobado de la plantilla, incluido el anuncio de restricción
dentro de los próximos 30 minutos, por indicación expresa del propietario. Este
botón envía el mensaje; no ejecuta ni reprograma comandos de bloqueo.

No modifica los recordatorios de dos días, Hoyvence o Datos. El recordatorio de
un día conserva su configuración desactivada.

La misma protección aplica al grupo `MORA` y a la plantilla `mora` del push
manual (`/api/creditos/push-manual`), y a la categoría `MORA` de los recordatorios
push automáticos. La previsualización expone el contador
`excludedActiveMoraProtection`, sin iniciar mensajes. Los avisos genéricos de la
app y los recordatorios de fechas próximas conservan sus reglas actuales.
