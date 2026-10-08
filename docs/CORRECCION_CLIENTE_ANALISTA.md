# Corrección de datos del cliente en solicitudes

El analista nominal puede corregir nombres, segundo apellido, nacimiento, celular,
correo, dirección, departamento y ciudad desde **Solicitudes → Editar datos**.
La cédula y el primer apellido permanecen bloqueados en la interfaz y en el servidor.

La validación de identidad iniciada no impide esta corrección auditada. El permiso
no se extiende al asesor ni a los accesos compartidos de aprobaciones. Las
solicitudes cerradas, convertidas o vencidas permanecen protegidas.

Antes del primer envío contractual se guardan los datos y el historial de manera
atómica. Si ya existe un proceso de FirmaSeguro, guardar exige confirmar una nueva
firma. Su documento se construye desde el sello de la versión anterior; mantiene
venta, inicial, financiación, cuotas, plazo, tasas, equipo, IMEI y primer pago.
El proceso anterior se archiva y conserva su documento e historial.

El despacho utiliza el registro durable existente de FirmaSeguro. La corrección,
la auditoría y el reemplazo del proceso se aplican juntos al reclamar el envío,
después de preparar el documento. Cada cambio registra usuario nominal, fecha,
motivo, datos anteriores y nuevos y correlación con el envío.

Una respuesta de envío no cuenta como firma. El cierre y la remisión dependen del
PDF firmado del proceso vigente. Una confirmación incierta exige conciliación;
no se vuelve a enviar automáticamente. Tras un fallo definitivo confirmado,
**Gestionar firma** permite reintentar el documento corregido con otra operación,
manteniendo los valores financieros originales.

Se conservan fotos, soportes y grabaciones. Las pestañas antiguas del asesor no
pueden reponer los datos corregidos ni borrar los marcadores del servidor. La
sincronización existente actualiza la solicitud abierta y descarta el contrato
anterior cuando corresponde una nueva firma.
