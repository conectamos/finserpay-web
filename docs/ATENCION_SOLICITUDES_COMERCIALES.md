# Solicitudes comerciales en Atención

El asesor entra desde su dashboard a **Solicitar aprobación**, selecciona un
crédito propio y solicita la llamada de bienvenida; esto no aprueba el crédito
ni su liquidación. **Solicitar enrolamiento** está en la tarjeta Enrolamiento
del paso visible 4, Enrolamiento y entrega, del crédito iPhone (paso interno 5).
Guarda primero el borrador actual y vincula el caso a ese identificador, sin
volver a buscar o seleccionar otra venta. El chat con el analista se abre en
un panel dentro del crédito, con los mensajes y soportes privados existentes.
No se ofrece la creación independiente de enrolamientos desde el dashboard.
Los enlaces de notificaciones e historial siguen abriendo sus casos originales.
El administrador central también puede solicitar desde esa misma tarjeta, usando
su sesión y la API de Atención. El asesor, la sede y el aliado siguen siendo los
de la operación; el mensaje y la auditoría identifican al administrador real.
No se inventa un asesor cuando la operación no tiene titular nominal válido.

Cada solicitud crea una conversación interna, sin emitir WhatsApp ni iniciar
llamadas. La relación se hace con el identificador de la operación existente y
su aliado/sede/titular. No se deduce la identidad del cliente desde el teléfono
del asesor. Solo puede existir un caso activo por tipo y operación. Repetir un
intento devuelve el caso ya registrado.

Administración central asigna/traslada los casos a analistas nominales activos.
Los analistas ven los asignados; el asesor ve los suyos y el supervisor puede
consultar los de su sede, sin escribir en nombre de otro asesor. Las notas
internas no se entregan al perfil comercial. Cambios de titular, baja de cuentas
y reasignaciones se revalidan en el servidor.

Los estados pendiente, en revisión, información pendiente y finalizada son
estados de gestión. La asignación se muestra por separado. Finalizar un caso no
registra una llamada realizada, un enrolamiento aprobado ni una decisión de
crédito. El resultado real conserva los módulos existentes:

- Enrolamiento: portal nominal de pruebas iPhone, con documento e IMEI del
  expediente y sus validaciones actuales.
- Bienvenida humana: expediente de aprobaciones y evidencia de llamada existente.
- Bienvenida Dapta: componente y API existentes de bienvenida de voz, con su
  confirmación explícita antes de llamar. Elegir modalidad no inicia llamadas.

En Atención, las bandejas comparten la navegación oscura y los selectores de tipo
con Clientes. La ficha se abre bajo demanda; conserva asignación, notas,
documentos e historial de gestión. La búsqueda y los filtros de lectura,
asignación y estado se consultan globalmente en el servidor, antes de paginar.
Los mensajes pendientes se calculan con las mismas marcas nominales de Atención,
sin confundirlos con la lectura de las notificaciones. Solo los mensajes entrantes
realmente mostrados al fondo del chat se confirman como leídos. Las vistas ocultas
pausan sus lecturas y vuelven a comprobar el acceso al regresar; los borradores
permanecen durante la navegación entre tipos.

Los participantes pueden escribir y adjuntar JPG/PNG o PDF. Los archivos son
privados, conservados con su mensaje y autor, sin enlaces públicos. Los límites
son 5 MB por imagen, 16 MB por PDF y 100 archivos/100 MB por caso. Los demás
soportes del trámite continúan en el expediente; la bandeja no inventa una lista
de documentos aprobados. Los eventos en vivo solo invalidan lecturas autorizadas;
la consulta periódica actúa como respaldo.

## Integraciones y límites

El canal WhatsApp actual, su número, Dapta y las automatizaciones existentes no
se modifican. No hay importación de grupos ni clasificación automática de sus
mensajes en estas nuevas solicitudes. La conversación interna del asesor y un
chat de WhatsApp son canales distintos. La vinculación/derivación automática de
solicitudes originadas por WhatsApp queda pendiente de una regla operativa y de
su implementación; no se presupone una API de grupos ni de Kommo.

El esquema se instala de manera aditiva con `setup-atencion.sql` y se verifica
en el predeploy de Railway. `AttentionWorkRequest` referencia la conversación,
usuario, vendedor y sede. La operación D/C se comprueba en la transacción y en
las lecturas, porque las solicitudes comerciales tienen almacenamiento legado
separado. `AttentionWorkFile` conserva los soportes privados. `AttentionAudit`
mantiene trazabilidad inmutable de los cambios.

## Piloto antes del traslado de operación

1. Elegir dos asesores con perfil nominal y PIN actualizado, un analista y un
   administrador central. Mantener los grupos actuales durante el piloto.
2. Cada asesor continúa un iPhone propio hasta Enrolamiento y entrega y pulsa
   Solicitar enrolamiento. Para bienvenida, selecciona un crédito existente en
   Solicitar aprobación. Confirmar cliente, aliado e IMEI antes de crear. Un
   segundo clic/intento debe abrir el mismo caso activo, sin duplicar avisos.
3. Central asigna los casos. Verificar que el analista asignado los ve y que otro
   analista, otro aliado y un asesor ajeno no pueden abrirlos ni descargar soportes.
4. Intercambiar un mensaje interno y un soporte de prueba autorizado. Comprobar
   recepción, notas reservadas, estado e historial desde ambos perfiles.
5. Ejecutar la revisión iPhone en el portal existente o la bienvenida en su
   mecanismo autorizado. Comprobar la evidencia real allí y después finalizar
   la gestión. La prueba de llamada/WhatsApp real requiere acción del operador;
   no forma parte del despliegue automático.
6. Acordar con el equipo la cobertura y el responsable de asignación antes de
   trasladar la operación de los grupos.
