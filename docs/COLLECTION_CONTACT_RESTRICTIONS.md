# Restricción de contactos de cobro

`COLLECTION_CONTACT_EXCLUDED_DOCUMENTS` es una variable exclusiva del servidor que contiene los documentos de clientes con restricción de cobro por WhatsApp y llamadas. No usar un prefijo `NEXT_PUBLIC_` ni guardar documentos reales en el repositorio.

La lista admite comas, punto y coma o saltos de línea. Cada documento debe tener entre 5 y 15 dígitos; puede incluir puntos, guiones o espacios internos. La comparación conserva los ceros iniciales y exige coincidencia completa. Las entradas con letras, signos, todos ceros o formato inválido se ignoran, sin convertirlas en el documento de otro cliente. Un valor ausente o vacío no restringe clientes.

La restricción corresponde al cliente por documento, incluidos sus créditos actuales y futuros. Persiste hasta retirar expresamente el documento de la variable. No registra una prórroga, no modifica la deuda ni sus fechas y no afecta los flujos de bienvenida o firma.

## Administración y verificación

1. Verificar el documento y la autorización antes de cambiar la variable en el servicio y entorno correctos de Railway. Conservar las exclusiones existentes al agregar o retirar una entrada.
2. Registrar el motivo, responsable y alcance del cambio en el control administrativo correspondiente; conservar la auditoría del cambio y despliegue en Railway. Esta configuración no crea por sí sola un evento de auditoría en la base de datos de FINSERPAY.
3. Aplicar el cambio y comprobar que el despliegue o reinicio que incorpora la variable está activo en cada proceso que envía cobros. El helper lee el entorno en cada llamada, pero editar Railway no cambia el entorno de un proceso que ya está ejecutándose.
4. Verificar la exclusión sin enviar un mensaje o iniciar una llamada, y comprobar que otros documentos conservan su comportamiento.

Las rutas de cobro deben consultar `isCollectionContactRestricted` al seleccionar destinatarios y nuevamente antes del envío o llamada, incluida la ejecución de trabajo pendiente. Los controles manuales deben mostrar `COLLECTION_CONTACT_RESTRICTION_REASON`. El helper no cancela contactos que el proveedor ya aceptó ni controla llamadas o mensajes efectuados fuera de FINSERPAY.

Las plantillas financieras y los botones de cobro aplican esta restricción. El texto libre, los archivos y los mensajes reenviados en Atención no se categorizan automáticamente como cobro: la restricción no bloquea toda la atención al cliente. Los operadores deben respetar la solicitud de no cobrar también en esas comunicaciones manuales. La consulta de cobranza para Dapta devuelve `suspenderCobranza: true` para el documento restringido, conservando la deuda y la historia reales; registrar el cierre auténtico de una gestión anterior sigue permitido.

Pruebas locales: `node --test tests/collection-contact-restriction.test.mjs`. Usan identificadores sintéticos y un entorno aislado, sin consultar clientes ni proveedores.
