# Identidad del cliente desde DataCrédito

El formulario consume la respuesta cifrada de la evaluación aprobada, incluyendo
la evaluación de origen cuando fue reutilizada. Abrir o recargar usa la base de
datos y no invoca al proveedor.

## Campos utilizados

Ruta: `content.respuesta.validacion.datosBasicos`, con `conInformacion` positivo.

- `primerNombre` y `segundoNombre`: se concatenan sin separar sus componentes.
- `primerApellido` y `segundoApellido`: se conservan completos.
- `tipoDocumento` y `numeroDocumento`: se validan; se quitan puntos del número.
- `nombreCompleto`: cuando faltan nombres o primer apellido estructurados, se
  utiliza completo en una única barra «NOMBRES Y APELLIDOS», sin dividirlo.
  Se conservan tildes, ñ, apellidos compuestos y espacios internos; únicamente
  se normaliza Unicode a NFC y se retiran espacios exteriores.

Este último caso se identifica con `nameMode: "FULL_NAME_ONLY"`. No exige
componentes separados ausentes para continuar, pero sí documento y tipo
coincidentes. Los componentes que efectivamente haya entregado el proveedor se
conservan como tales; los demás permanecen vacíos. El servidor descarta los
componentes inventados o antiguos enviados por el navegador y fija el nombre
completo efectivo de la evaluación guardada.

`infoTransaccion.apellidoDigitado` y el apellido de la solicitud al proveedor no
son identidad verificada. El apellido digitado se conserva exclusivamente para
validar la vinculación criptográfica de la evaluación original.

La respuesta completa ya se almacenaba cifrada, pero el formulario no recibía
estos campos. El parser de riesgo sigue leyendo score, estado, indicadores de
información y código de transacción. No se cambia la petición paga.

## Evidencia disponible y límite de la integración

La captura de producción reportada el 9 de octubre de 2026 muestra una
evaluación aprobada con `nombreCompleto`, tipo y número de documento recuperados,
pero con «Nombre(s)» y «Primer apellido» señalados como ausentes. Esta evidencia
motivó el modo de nombre completo solicitado posteriormente: no se divide el
nombre para simular esos campos. Confirma que el extractor no encontró los componentes
estructurados esperados para ese expediente. No confirma que estén ausentes en
todas las rutas posibles del payload original.

No fue posible inspeccionar directamente ese expediente cifrado en este entorno:
no hay `DATABASE_URL` configurado. Los campos estructurados contemplados por el
parser proceden de la integración existente y sus fixtures; el repositorio no
incluye un contrato OpenAPI/XSD ni una respuesta real que confirme su entrega.
El extractor lee la respuesta original descifrada, antes de la allowlist del
reporte administrativo, por lo que esa allowlist no elimina los campos usados
por el autollenado.

La [descripción oficial de MiDecisor de DataCrédito Experian](https://www.datacredito.com.co/empresas/midecisor-empresas),
en «Valida la identidad del consultado», anuncia nombre completo, tipo y número
de identificación y rango de edad. Esa descripción comercial no documenta
campos separados de nombres y apellidos ni garantiza que el producto contratado
los entregue.

Para obtener nombres y apellidos separados se requiere revisar, con acceso autorizado, un
expediente ya guardado y contrastarlo con el contrato técnico de la versión y
producto MiDecisor contratado. Si los componentes existen en otra ruta, debe
implementarse su mapeo oficial documentado. Si la respuesta sólo incluye
`nombreCompleto`, se debe solicitar a Experian la habilitación o el producto que
entregue nombres y apellidos estructurados, confirmando el contrato de respuesta
y su efecto en costos antes de cambiar la petición. No se agregarán aliases
supuestos, ni se ejecutará otra consulta paga para este diagnóstico. No se puede
identificar con certeza nombres y apellidos compuestos a partir de una cadena de
nombre completo. La nueva barra permite utilizar exactamente el nombre completo
ya recibido; no demuestra que la integración entregue componentes estructurados.
La respuesta administrativa actual aplica una allowlist y no permite descartar
propiedades desconocidas mirando únicamente ese reporte. No se añadió un
diagnóstico nuevo del payload ni una consulta adicional.

## Correcciones y datos ausentes

Cuando existen componentes estructurados, el asesor habilita únicamente nombres y segundo apellido con «Editar nombres y
segundo apellido». Un segundo apellido vacío es válido. Cada corrección se
registra en `DataCreditoIdentityCorrection` con original, anterior, efectivo,
usuario, vendedor y fecha del servidor. El formulario restaurado lee el valor
efectivo; el original se conserva. Los datos completados o corregidos se
identifican como intervención humana, no como nuevos datos verificados.

En modo `FULL_NAME_ONLY` la barra completa permanece bloqueada: editarla también
permitiría cambiar el primer apellido. Las correcciones de nombres o segundo
apellido ya auditadas se conservan al recargar, junto con el nombre completo
original del proveedor. Una revisión antigua que sólo completó un primer
apellido faltante no sustituye el nombre completo por ese apellido parcial.

Si no hay nombre completo y faltan nombres, el asesor puede completarlos mediante la misma opción,
quedando el registro correspondiente. Si faltan documento o primer apellido,
la firma y la creación del crédito quedan bloqueadas hasta una revisión. Si hay
nombre completo confiable, la ausencia de nombres o apellidos separados no se
presenta como falta de identidad. La ausencia de documento o tipo sigue bloqueando.

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

Este procedimiento administrativo existente no se expone como edición de primer
apellido en la barra del asesor. Las revisiones que lo utilicen deben confirmar
el componente a partir del documento; no se deduce del nombre completo ni se
adopta el apellido digitado para consultar. La transacción bloquea la evaluación,
revalida que siga aprobada y sin consumir, y vuelve a leer la última corrección
antes de guardar. Dos peticiones concurrentes no pueden reemplazar entre sí un
campo primario completado por la otra. La intervención queda identificada como
humana y no demuestra que ese componente venga de DataCrédito.

## Persistencia y documentos

El borrador y la solicitud guardan el nombre completo efectivo y los componentes
disponibles. En modo `FULL_NAME_ONLY` los componentes ausentes permanecen vacíos.
El registro del
cliente en `Credito` conserva todos los nombres en `clientePrimerNombre` y el
nombre completo efectivo en `clienteNombre`; el segundo apellido estructurado y
la procedencia se conservan también en `contratoSnapshot.dataCreditoIdentity`.
El snapshot del contrato incluye `cliente.segundoApellido`.

Contrato, pagaré y PDF usan el mismo nombre completo efectivo. Cuando DataCrédito
entrega componentes, FirmaSeguro recibe los nombres estructurados del snapshot,
incluido segundo apellido o null, sin volver a separar por espacios.

FirmaSeguro exige nombres y apellidos separados en su contrato actual. Para el
modo de nombre completo se utilizan únicamente componentes estructurados de la
última validación Veriff aprobada del mismo borrador y documento, si juntos
coinciden con el nombre completo canónico. Se guardan en metadata separada con
procedencia `VERIFF`; no se atribuyen a DataCrédito ni reemplazan el nombre de los
documentos. Si falta esa evidencia o no coincide, se devuelve un bloqueo
controlado antes del envío. No se inventan componentes para satisfacer la API.
El servidor exige guardar las correcciones antes de firmar o crear el crédito,
y verifica documento y ámbito del asesor.

La tabla de auditoría está incluida en `scripts/setup-datacredito.sql`; también
se crea de forma compatible al recuperar identidad por primera vez.

## Verificación local

`npm run test:datacredito` incluye extracción, compuestos, tildes y ñ, ausencia
de datos, documento diferente, bloqueo de campos, segundo apellido vacío,
restauración de correcciones, modo de nombre completo sin división, rechazo de
nombres alterados o documentos distintos, revisión administrativa concurrente y
nombres de FirmaSeguro.
La auditoría se ejecuta contra PostgreSQL embebido (PGlite), verificando fecha y
responsable sin una conexión externa ni consultas pagas.

La publicación se prepara sobre la versión vigente de producción y verifica
TypeScript y la compilación completa en una copia aislada. No se realizó una
prueba visual con sesión real ni un envío real a FirmaSeguro.
