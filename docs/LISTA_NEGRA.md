# Lista negra global

## Operación

El administrador central de FINSER PAY dispone de **Administración → LISTA NEGRA** (`/dashboard/lista-negra`). Puede registrar una cédula con motivo, buscar registros y desactivar o reactivar un bloqueo con confirmación y motivo obligatorio. Los administradores de aliados y los vendedores no pueden listar, modificar ni ver los motivos internos. El bloqueo de ventas y consultas sí aplica también al administrador central.

La identidad se normaliza eliminando puntos, guiones, espacios y ceros iniciales. Se aceptan de 3 a 13 dígitos canónicos, sin letras. El registro es único por cédula, sin alcance por aliado. Todas las nuevas ventas directas requieren `clienteDocumento`; las ventas históricas conservan su valor previo, incluido `null`.

## Carga masiva de texto

En la misma pantalla, selecciona **Pegar lista**:

1. Pega hasta 500 entradas, una por línea o separadas por comas, punto y coma o tabulaciones. También se acepta el encabezado de una columna (`Cédula`, `Documento` o `CC`).
2. Escribe un motivo común de 5 a 500 caracteres.
3. Previsualiza para distinguir nuevas, reactivaciones, ya bloqueadas, repetidas e inválidas. El detalle se pagina de 25 en 25; no se recorta el lote.
4. Corrige todas las entradas inválidas y vuelve a previsualizar. La notación científica, letras y listas ambiguas separadas sólo por espacios no se convierten en cédulas inventadas.
5. Confirma el alcance global antes de guardar. Las nuevas y las inactivas se bloquean; las activas y repetidas se omiten sin cambiar el motivo anterior.

No hay importación parcial: filas inválidas, una previsualización obsoleta o un fallo de auditoría revierten toda la operación. La interfaz conserva el mismo identificador al reintentar una respuesta incierta. El resultado de una carga ya registrada se devuelve como histórico, sin reaplicarla si otra persona desactivó después alguna cédula.

La API central usa POST `/api/lista-negra/masivo/previsualizar` y POST `/api/lista-negra/masivo`. El servidor vuelve a validar texto, motivo, confirmación y estado/versiones después de adquirir los mismos bloqueos por cédula que utilizan ventas y crédito. El lote y cada cambio tienen historial inmutable. La entrada está limitada a 50.000 caracteres y el cuerpo HTTP real a 150.000 bytes, incluso sin `Content-Length`.

## Controles del servidor

- Consulta DataCrédito: revisión antes de reservar, reutilizar o llamar al proveedor. La llamada pagada comparte el bloqueo transaccional por cédula con la administración de la lista.
- Crédito nuevo y masivo: revisión inicial y dentro de la transacción final. Borradores, consultas de cupo manual, reanudación y pasos previos de identidad/firma también verifican la cédula.
- Venta directa: revisión antes de consultar inventario y dentro de la transacción que registra la venta y mueve inventario.
- Los autoguardados que omiten la cédula utilizan la identidad almacenada; adquieren sus bloqueos antes de bloquear la solicitud. Si la identidad cambia concurrentemente, devuelven `409 DRAFT_IDENTITY_CHANGED` para recargar.
- Una operación que ya obtuvo el bloqueo por cédula puede finalizar antes de que se confirme su alta en la lista. Una vez confirmado el bloqueo, las nuevas operaciones se rechazan. Una consulta en curso puede hacer que el administrador deba reintentar el registro si supera el tiempo de espera.
- No se modifican créditos, pagos, recaudos ni ventas históricas. El reintento autorizado de un cierre que ya creó el crédito puede recuperar su resultado existente, sin volver a vender.
- Si la tabla, conexión o comprobación no está disponible, se rechaza el avance con `503 DOCUMENT_BLACKLIST_UNAVAILABLE`; nunca se interpreta el fallo como autorización.

`/api/lista-negra` admite GET (búsqueda/estado/paginación), POST (registrar/reactivar) y PATCH (activar/desactivar con versión vigente). Todos requieren sesión de administrador central. Las escrituras tienen `mutationId`, control de concurrencia, actor obtenido de la sesión e historial inmutable en `ListaNegraDocumentoEvento`. No hay eliminación física por API.

## Preparación y despliegue

`scripts/railway-predeploy.mjs` ejecuta `ensure-document-blacklist-schema.mjs` antes del arranque. El script es transaccional e idempotente: prepara las tablas de cédulas, eventos y recibos de carga (`ListaNegraImportacion`), índices y protección de auditoría; conserva la columna nullable `Venta.clienteDocumento`. La ampliación masiva sólo añade su tabla de recibos y protección de inmutabilidad. No carga cédulas, no ejecuta actualizaciones de negocio y no borra históricos. Docker incluye ambos scripts de esquema.

Este cambio requiere autorización de publicación. No ejecutar scripts de pruebas ni cargar datos sintéticos contra producción.

## Pruebas

`npm run test:lista-negra` ejecuta pruebas de normalización, permisos, rutas de ventas/crédito, recuperación de cierre, orden de bloqueos, idempotencia y auditoría. Las pruebas PostgreSQL requieren `BLACKLIST_TEST_DATABASE_URL`, aceptan únicamente localhost y una base llamada `blacklist_test` o `blacklist_test_<sufijo>`. Utilizan cédulas y usuarios sintéticos y el cliente Prisma real. Sin esa variable, sólo se omite la integración PostgreSQL.

Validaciones complementarias: `npm run lint`, `npx tsc --noEmit` y `npm run build`. Los archivos temporales de capturas/harness no forman parte del cambio.

### Verificación inicial del módulo individual (8 de septiembre de 2026)

- 49 pruebas específicas aprobadas, sin omitir la integración PostgreSQL.
- Batería completa: 608 aprobadas y 2 fallidas, ninguna omitida. Los dos fallos se reprodujeron sin cambios en la base `b81a99a`: `colombia-locations.test.mjs:165` y `veriff-retry-policy.test.mjs:83`; no se modificaron para este módulo.
- Lint global: sin errores (66 advertencias existentes). TypeScript y compilación de producción aprobados.
- Compilación servida en localhost: GET/POST/PATCH de la API sin sesión devuelven 401; la página redirige al inicio; salud 200.
- Apariencia de escritorio revisada con datos sintéticos. No se certificaron interacción visual ni vista móvil: la herramienta interactiva no estuvo disponible en este entorno.
- Esa validación precedió a la publicación autorizada del módulo individual. La carga masiva requiere su propia autorización de publicación.

### Verificación de la ampliación masiva

- 108 pruebas de lista negra aprobadas, incluidas las de importación y PostgreSQL real. El lote de 500 entradas guarda una única auditoría por cédula y un único recibo.
- Batería completa final: 667 aprobadas y los mismos 2 fallos previos documentados arriba, ninguna omitida. Lint sin errores (66 advertencias existentes) y compilación de producción aprobada.
- Se verificaron repetidos, omitidos activos, reactivación, reintentos tras desbloqueos posteriores, rollback, lotes concurrentes y el orden real de bloqueo en PostgreSQL.
- Pruebas de interacción de la pantalla: previsualización obligatoria, respuestas obsoletas, límite con encabezado, confirmación, doble clic, reintento conservando UUID, respuesta histórica y paginación.
- No se realizaron cargas masivas ni cambios de datos de producción durante el desarrollo. No se certificó una revisión visual en navegador para esta ampliación.
