# Exportación de clientes desde Solicitudes

El botón **Descargar base** del muro está disponible para administradores. El
diálogo conserva los filtros aplicados del muro y permite combinar aliados,
sedes, vendedores, estado, plataforma, búsqueda y periodo (histórico, mes o
rango). Los selectores incluyen entidades inactivas con historia autorizada.
El conteo cubre todos los resultados, independientemente de la página visible.

## Datos y fechas

- Una fila por solicitud. Un borrador convertido se representa por su crédito,
  conservando el número y la creación del borrador vinculado cuando existe.
  Créditos sin borrador conservan su folio y creación. Cédulas repetidas en
  solicitudes distintas no se deduplican.
- Periodos según creación de la solicitud en `America/Bogota`: inicio inclusivo,
  final exclusivo a medianoche del día siguiente. Se permiten extremos abiertos.
- Las relaciones de evaluaciones, validaciones y firmas aportan únicamente el
  último estado almacenado. No se invoca ningún proveedor externo.
- El Excel tiene 26 columnas explícitas. Solo el Sadmin confirmado se exporta;
  si no existe, se escribe `PENDIENTE SADMIN`. Otros datos faltantes quedan vacíos.
- Identificadores como texto, importes numéricos en COP, encabezado inmovilizado,
  filtros y anchos legibles. Los textos nunca se asignan como fórmulas o enlaces.
  Si una hoja alcanza el límite de Excel se continúa en una nueva hoja.

## Permisos y descarga

Todos los endpoints de `/api/solicitudes/export` resuelven al administrador desde
su sesión. El administrador aliado queda restringido por el aliado de su sede
de acceso. Los identificadores enviados se validan contra las entidades
autorizadas; pedir una entidad de otro aliado devuelve 403.

Los trabajos pertenecen al usuario que los creó. La generación vuelve a consultar
su cuenta activa, rol y aliado. Para entregar el archivo se comprueba nuevamente
la sesión, los filtros guardados y la propiedad actual de cada solicitud del
archivo. Un cambio de rol, aliado o propiedad bloquea la descarga afectada.
Los archivos carecen de URL pública y se sirven con `private, no-store`.

La auditoría permanente registra usuario, fecha, evento, filtros de alcance y
cantidad. Nunca guarda filas de clientes ni el texto de búsqueda: solo registra
si se aplicó una búsqueda. Los filtros operativos y archivos caducan a las 24
horas; iniciar una descarga cerca del vencimiento concede 15 minutos de margen.

## Generación y operación

La petición crea un trabajo persistido y responde 202. Next.js `after` inicia el
procesamiento; el diálogo consulta el estado. El proceso Node de producción
también revisa la cola cada minuto desde `instrumentation.ts`, incluso después
de reinicios o de cerrar la ventana.

La generación usa lotes de 1.000 solicitudes dentro de una transacción de lectura
repetible, un escritor XLSX por streaming y fragmentos privados de 1 MiB en
PostgreSQL. Los archivos temporales se eliminan al terminar o fallar. Los
fragmentos se publican únicamente al completar el archivo y comprobar que su
conteo coincide. El almacenamiento compartido permite descargar desde otra
réplica del servicio.

Si cambia el conteo antes de generar, se solicita actualizarlo. Un trabajo
interrumpido se marca fallido después de tres minutos sin actividad; no entrega
un archivo parcial. Se permiten dos trabajos activos por usuario. La transacción
de generación tiene un máximo explícito de 30 minutos: si se supera, falla y
permite reintentar con un periodo menor, sin truncar resultados.

Preparación del esquema (incorporada al predeploy de Railway):

```sh
npm run db:setup-solicitudes-export
```

El instalador y la aplicación comparten
`lib/solicitudes-export-schema-statements.json`. El esquema existente del muro y de los
estados de proveedores debe estar preparado por el predeploy habitual.
En producción la aplicación verifica que existan las tablas de exportación;
su creación corresponde al instalador de predeploy.

## Verificación local

```sh
npm run test:solicitudes-export
npm run test:solicitudes
```

Las pruebas usan PostgreSQL local embebido (PGlite), datos ficticios y lectura de
los XLSX generados con ExcelJS. Cubren roles, ataques entre aliados, combinaciones
de filtros, límites de Bogotá, duplicados, conteos, ceros iniciales, textos con
aspecto de fórmula, históricos grandes, ausencia de resultados, cola, archivos
incompletos y revocación de permisos. No consultan la base de producción.

Verificación de implementación: 44 pruebas nuevas y 178 regresiones del muro
aprobadas; compilación integral, TypeScript y ESLint de los archivos nuevos sin
errores. El componente real se revisó en navegador con API ficticia en escritorio
y móvil, incluyendo filtros, vacío, progreso y reapertura del archivo listo.

PGlite verifica SQL y transacciones locales, pero no reproduce concurrencia entre
conexiones de PostgreSQL. El verificador siguiente comprueba el servicio desplegado.

## Verificación en el servicio desplegado

`scripts/verify-solicitudes-export-production.mjs` utiliza `DATABASE_URL` y
`SESSION_SECRET` del servicio, sin imprimirlos. Opcionalmente acepta
`FINSERPAY_VERIFY_BASE_URL` (por defecto `https://finserpay.com`). La conexión SQL
se configura en modo solo lectura; no crea usuarios ni cambia sus permisos.
Las únicas escrituras son los trabajos y eventos de auditoría que generan las
peticiones normales a la función de exportación.

El verificador selecciona cuentas existentes de administrador central y aliado,
consulta opciones y conteos, y descarga una muestra de hasta 25 solicitudes por
rol. La muestra central mantiene vacíos los filtros de aliado, sede y vendedor;
acota fecha y búsqueda para comprobar el alcance general con pocos datos. Los
XLSX se validan únicamente en memoria contra el manifiesto y la propiedad actual
de las solicitudes. La salida contiene estados, identificadores y cantidades;
no incluye datos de clientes, cookies, secretos ni cuerpos de respuesta.

Ejecutar con las variables del servicio disponibles únicamente en el entorno,
después de confirmar que el despliegue deseado está activo:

```sh
node scripts/verify-solicitudes-export-production.mjs
```

Comprueba también los rechazos por identificadores externos, otro rol y acceso a un trabajo
de otro usuario. Un error HTTP muestra el código de estado recibido, sin su cuerpo.
