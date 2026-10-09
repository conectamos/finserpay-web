# Identidad del cliente desde DataCrédito

El formulario consume la respuesta cifrada de la evaluación aprobada, incluyendo
la evaluación de origen cuando fue reutilizada. Abrir o recargar usa la base de
datos y no invoca al proveedor.

## Campos utilizados

Ruta: `content.respuesta.validacion.datosBasicos`, con `conInformacion` positivo.

- `primerNombre` y `segundoNombre`: se concatenan sin separar sus componentes.
- `primerApellido` y `segundoApellido`: se conservan completos.
- `tipoDocumento` y `numeroDocumento`: se validan; se quitan puntos del número.
- `nombreCompleto`: se muestra como referencia cuando existe, sin dividirlo.

`infoTransaccion.apellidoDigitado` y el apellido de la solicitud al proveedor no
son identidad verificada. El apellido digitado se conserva exclusivamente para
validar la vinculación criptográfica de la evaluación original.

La respuesta completa ya se almacenaba cifrada, pero el formulario no recibía
estos campos. El parser de riesgo sigue leyendo score, estado, indicadores de
información y código de transacción. No se cambia la petición paga.

No fue posible inspeccionar una respuesta real en este entorno: no hay
`DATABASE_URL` configurado. Los nombres de campos anteriores provienen de la
integración existente y sus fixtures, no de una confirmación de producción.
Antes de publicar, revisar un registro cifrado existente con acceso autorizado;
no es necesario consultar nuevamente a DataCrédito. Si solo existe
`nombreCompleto`, solicitar al proveedor que habilite los campos estructurados
anteriores para el producto MiDecisor contratado, o su mapeo oficial documentado.
No se puede identificar con certeza nombres y apellidos compuestos a partir de
una cadena de nombre completo.

## Correcciones y datos ausentes

El asesor habilita únicamente nombres y segundo apellido con «Editar nombres y
segundo apellido». Un segundo apellido vacío es válido. Cada corrección se
registra en `DataCreditoIdentityCorrection` con original, anterior, efectivo,
usuario, vendedor y fecha del servidor. El formulario restaurado lee el valor
efectivo; el original se conserva. Los datos completados o corregidos se
identifican como intervención humana, no como nuevos datos verificados.

Si faltan nombres, el asesor puede completarlos mediante la misma opción,
quedando el registro correspondiente. Si faltan documento o primer apellido,
la firma y la creación del crédito quedan bloqueadas hasta una revisión.

Procedimiento administrativo para datos primarios ausentes:
`PATCH /api/creditos/datacredito/evaluaciones/{id}` con exclusivamente los campos
faltantes `firstSurname`, `documentType` y/o `documentNumber`. Requiere sesión de
administrador de la misma sede y aliado, evaluación aprobada y sin consumir.
Solo admite completar valores no entregados; nunca sustituye un valor del
proveedor. El número debe coincidir exactamente con el consultado y el tipo
admitido actualmente es `CEDULA_DE_CIUDADANIA`. La revisión queda auditada y
marcada en `effective.manuallyCompleted`. Recargar el formulario recupera el
resultado. Este procedimiento administrativo no habilita al asesor para editar
esos campos.

## Persistencia y documentos

El borrador y la solicitud guardan nombres y ambos apellidos. El registro del
cliente en `Credito` conserva todos los nombres en `clientePrimerNombre` y el
nombre completo efectivo en `clienteNombre`; el segundo apellido estructurado y
la procedencia se conservan también en `contratoSnapshot.dataCreditoIdentity`.
El snapshot del contrato incluye `cliente.segundoApellido`.

Contrato, pagaré y PDF usan el nombre completo efectivo. FirmaSeguro recibe los
nombres estructurados del snapshot, incluido segundo apellido o null, sin volver
a separar por espacios. El servidor exige guardar las correcciones antes de
firmar o crear el crédito, y verifica documento y ámbito del asesor.

La tabla de auditoría está incluida en `scripts/setup-datacredito.sql`; también
se crea de forma compatible al recuperar identidad por primera vez.

## Verificación local

`npm run test:datacredito` incluye extracción, compuestos, tildes y ñ, ausencia
de datos, documento diferente, bloqueo de campos, segundo apellido vacío,
restauración de correcciones, revisión administrativa y nombres de FirmaSeguro.
La auditoría se ejecuta contra PostgreSQL embebido (PGlite), verificando fecha y
responsable sin una conexión externa ni consultas pagas.

La publicación se prepara sobre la versión vigente de producción y verifica
TypeScript y la compilación completa en una copia aislada. No se realizó una
prueba visual con sesión real ni un envío real a FirmaSeguro.
