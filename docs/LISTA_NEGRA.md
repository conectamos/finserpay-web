# Lista negra global

## Operación

El administrador central de FINSER PAY dispone de **Administración → LISTA NEGRA** (`/dashboard/lista-negra`). Puede registrar una cédula con motivo, buscar registros y desactivar o reactivar un bloqueo con confirmación y motivo obligatorio. Los administradores de aliados y los vendedores no pueden listar, modificar ni ver los motivos internos. El bloqueo de ventas y consultas sí aplica también al administrador central.

La identidad se normaliza eliminando puntos, guiones, espacios y ceros iniciales. Se aceptan de 3 a 13 dígitos canónicos, sin letras. El registro es único por cédula, sin alcance por aliado. Todas las nuevas ventas directas requieren `clienteDocumento`; las ventas históricas conservan su valor previo, incluido `null`.

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

`scripts/railway-predeploy.mjs` ejecuta `ensure-document-blacklist-schema.mjs` antes del arranque. El script es transaccional e idempotente: crea las dos tablas, índices y protección de auditoría; añade únicamente la columna nullable `Venta.clienteDocumento`. No carga cédulas, no ejecuta actualizaciones de negocio y no borra históricos. Docker incluye ambos scripts de esquema.

Este cambio requiere autorización de publicación. No ejecutar scripts de pruebas ni cargar datos sintéticos contra producción.

## Pruebas

`npm run test:lista-negra` ejecuta pruebas de normalización, permisos, rutas de ventas/crédito, recuperación de cierre, orden de bloqueos, idempotencia y auditoría. Las pruebas PostgreSQL requieren `BLACKLIST_TEST_DATABASE_URL`, aceptan únicamente localhost y una base llamada `blacklist_test` o `blacklist_test_<sufijo>`. Utilizan cédulas y usuarios sintéticos y el cliente Prisma real. Sin esa variable, sólo se omite la integración PostgreSQL.

Validaciones complementarias: `npm run lint`, `npx tsc --noEmit` y `npm run build`. Los archivos temporales de capturas/harness no forman parte del cambio.

### Verificación del cambio (8 de septiembre de 2026)

- 49 pruebas específicas aprobadas, sin omitir la integración PostgreSQL.
- Batería completa: 608 aprobadas y 2 fallidas, ninguna omitida. Los dos fallos se reprodujeron sin cambios en la base `b81a99a`: `colombia-locations.test.mjs:165` y `veriff-retry-policy.test.mjs:83`; no se modificaron para este módulo.
- Lint global: sin errores (66 advertencias existentes). TypeScript y compilación de producción aprobados.
- Compilación servida en localhost: GET/POST/PATCH de la API sin sesión devuelven 401; la página redirige al inicio; salud 200.
- Apariencia de escritorio revisada con datos sintéticos. No se certificaron interacción visual ni vista móvil: la herramienta interactiva no estuvo disponible en este entorno.
- Sin despliegue y sin cambios de datos de producción.
