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
evaluación aprobada con `nombreCompleto` y documento mostrado en el formulario,
pero con «Nombre(s)» y «Primer apellido» señalados como ausentes. La captura no permite distinguir qué campos documentales proceden de la respuesta y cuáles de la consulta. Esta evidencia
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
quedando el registro correspondiente. Si falta el primer apellido sin un nombre completo confiable, la firma y la creación del crédito quedan bloqueadas hasta una revisión. Si hay
nombre completo confiable, la ausencia de nombres o apellidos separados no se
presenta como falta de identidad. Un borrador incompleto puede guardarse. En modo de nombre completo, el documento se vincula a la consulta cifrada y el tipo CC corresponde a la petición real del proveedor; si estos campos faltan en la respuesta, permanecen ausentes en la evidencia de DataCrédito. La aprobación documental de Veriff para esa misma cédula y solicitud se exige al continuar hacia la firma.

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
cliente en `Credito` conserva los nombres estructurados disponibles en `clientePrimerNombre` y el
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
documentos. Si Veriff aprueba la misma cédula pero no entrega los componentes, la validación
de identidad puede continuar. Antes del primer envío a FirmaSeguro, un administrador
autorizado puede transcribir los componentes desde la cédula mediante una revisión
nominal registrada. El nombre completo de DataCrédito permanece bloqueado y la
concatenación íntegra debe coincidir con él; no hay separación automática ni
reemplazo del primer apellido por el asesor. El segundo apellido puede quedar vacío.
La revisión conserva usuario, fecha del servidor, motivo, atestación y vinculación
a evaluación, solicitud y última validación Veriff. Su procedencia es
`AUTHORIZED_REVIEW`, distinta de DataCrédito y Veriff. No habilita la firma por
sí misma: la aprobación de Veriff para el mismo documento sigue siendo obligatoria.

La [documentación oficial de FirmaSeguro V2](https://firmaseguro.atlassian.net/wiki/spaces/FIRMASEGUR/pages/353468417/Consumo+API+PROCESS+Crear+procesos+de+Firma+V2)
exige `firstName` y `firstLastName` (2 a 100 caracteres), y permite
`secondName` y `secondLastName` nulos. No documenta un campo único de nombre
completo como sustituto. Por eso no se duplica el nombre ni se usa un apellido
inventado para satisfacer la API. Una evidencia presente y contradictoria no
se convierte en ausencia ni se reemplaza mediante la revisión nominal.
Guardar la revisión es una operación local y no envía una firma ni consulta
DataCrédito. Las revisiones vencidas por cambio de documento, nombre, evaluación
o validación no se reutilizan. Un contrato enviado, incierto o firmado conserva
su identidad y no admite este procedimiento previo al envío.
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

## Guardado automático y documento consultado

Cada transición autorizada de paso confirma el guardado antes de navegar. El
registro de borrador puede conservar información incompleta sin tratarla como
identidad verificada. La firma y la creación mantienen sus controles de aprobación,
propiedad, documento y solicitud; guardar no equivale a aprobar ni firmar.

Para el modo de nombre completo, un número o tipo omitido por el proveedor no
se inventa en `original`, `effective` ni se elimina de `missing`. La validación
operativa del documento utiliza la cédula de la consulta cifrada y el tipo CC
que realmente envía la integración (`tipoIdentificacion: "1"`). Un número o tipo
presente y contradictorio se rechaza. Veriff valida esa misma cédula; sus datos
siguen teniendo procedencia separada. La integración acepta campos documentales
estructurados de cadena o números enteros seguros, sin convertir nombres ni
admitir números que hayan perdido precisión.

Los rechazos del guardado devuelven el motivo específico y registran únicamente
el código técnico de identidad, sin nombres, cédulas ni contenido del proveedor.

## Regresión de venta y revisión para firma

`npm run test:credit-origination` ejecuta las suites de DataCrédito, solicitudes,
FirmaSeguro y cierre. Incluye una solicitud persistida en PostgreSQL embebido
que recorre el guardado de Cliente y Equipo, la recarga, una aprobación Veriff
confiable, la preparación del PDF y del destinatario, el despacho simulado,
la recepción autenticada de la firma, entrega y cierre transaccional del registro.
Se comprueba que el nombre compuesto con tildes y ñ se conserva, que no se
aceptan otra cédula o propietario y que los reintentos no duplican la firma ni
el crédito. Autenticación de sesión, configuración financiera y red del proveedor
se sustituyen por fixtures; no es una venta real ni una prueba de navegador.

Las pruebas de revisión nominal comprueban por separado autorización, campos
bloqueados, coincidencia del nombre íntegro, segundo apellido opcional, auditoría,
idempotencia, inmutabilidad y rechazo de una validación o envío obsoletos.
El endpoint es `GET/POST /api/creditos/borradores/{id}/identidad-firma`.
La revisión se almacena fuera del payload editable del borrador, en
`FirmaSeguroIdentityReview`; el servidor la recupera y valida antes de sellarla
con el contrato. Un autosave no puede crearla, cambiarla ni borrarla.

El workflow `Venta, identidad y firma` ejecuta esta regresión y `npm run build`
en las solicitudes de cambio y en main que afecten el flujo. No necesita
credenciales de proveedores ni acceso a producción. Sus resultados no sustituyen
la confirmación del estado de un expediente real cuando éste presente otro error.

El constructor de documentos trabaja sobre una copia del payload: recuperar
la identidad no puede modificar el objeto que el ledger compara con la fila
persistida al reservar el envío. El cierre conserva la escritura exacta del
nombre firmado cuando el sello financiero sólo normalizó mayúsculas y espacios;
el sello y su checksum permanecen intactos. Un nombre distinto, incluyendo otra
acentuación o ñ, no obtiene esa equivalencia de formato.
