# Aprobaciones documentales para liquidación a aliados

El módulo `/dashboard/aprobaciones` permite revisar el expediente de un crédito
de un aliado y registrar el **OK para liquidación**. La aprobación es un requisito
adicional de la liquidación: no desembolsa dinero ni cambia los valores del
crédito, su contrato firmado o una liquidación ya pagada.

## Acceso y operación

El administrador central de FINSER PAY y los usuarios activos con el rol
`ANALISTA_APROBACION` de la central pueden acceder. El analista dispone de este
panel; el rol no concede acceso a la fábrica de créditos, recaudos, administración
de usuarios, políticas de riesgo ni al expediente completo de DataCrédito.
La creación y administración de analistas corresponde al administrador central.
Los vendedores no pueden consultar expedientes desde aprobaciones. Los
administradores de aliados acceden a sus novedades mediante PENDIENTES; allí
solo pueden responder lo solicitado sobre créditos de su propio aliado.

### Enlace común y muro

En **Aprobaciones**, el administrador central genera y copia un enlace común
sin elegir ni crear una cuenta de analista. La dirección tiene la forma
`/acceso-revision#acceso=<secreto>` y abre **Muro de aprobaciones** en
`/revision-creditos`. El navegador retira el fragmento antes del canje y no
lo guarda en almacenamiento local. El enlace vigente permite nuevas aperturas;
la sesión propia dura **8 horas**. Regenerar o revocar invalida el enlace
anterior y todas sus sesiones, sin desactivar usuarios ni cambiar otras sesiones.

Cada petición comprueba enlace, sesión y acceso al crédito. Sus acciones quedan
registradas como **Acceso compartido**, con grant y sesión; no se atribuyen a un
usuario inventado. El portal no concede acceso a administración, fábrica ni
pagos. Cuando el mismo navegador conserva una cuenta individual, el panel avisa
si las revisiones se atribuirán al acceso compartido y permite cerrarlo.

El muro ofrece dos vistas sin búsqueda por cédula:

- **Pendientes por aprobar**: créditos sujetos al control, de todos los aliados
  externos, pendientes y sin liquidación pagada. Ordena por antigüedad e incluye
  novedades esperando al aliado y correcciones que el analista debe revisar.
- **Aprobadas**: créditos con un OK de liquidación vigente, del más reciente al
  más antiguo. Incluye aprobaciones previas sin audio y créditos ya incluidos en
  liquidación. Muestra fecha y autor del OK; su expediente se consulta en lectura.

Solo confirmar el OK tras revisar el expediente mueve un crédito a Aprobadas.
Un cambio posterior que invalide la aprobación lo devuelve a Pendientes.
Aprobadas no es un listado de eventos históricos invalidados. Ambas vistas
paginan sin fotos, documentos ni audio en la respuesta de la lista. El refresco
periódico respeta formularios abiertos y exige revisar otra vez cuando cambia el
expediente; cambiar de pestaña cancela las consultas de la vista anterior.

### Enlaces personales

En **Usuarios > Analistas de aprobación**, el administrador central puede
**Generar enlace**, **Copiar enlace**, **Abrir**, **Regenerar enlace** y
**Revocar**. El enlace corresponde a la misma cuenta individual del analista y
se puede reutilizar mientras esté vigente. Regenerarlo o revocarlo requiere
confirmación. La tabla muestra el secreto enmascarado; copiar conserva el enlace
completo. Una cuenta inactiva no permite generar, copiar ni abrir su acceso, y
la tabla vuelve a consultar el enlace cuando cambia la cuenta.

La dirección tiene la forma `/acceso-aprobaciones#acceso=<secreto>`. El navegador
retira inmediatamente el fragmento del historial y de la barra de direcciones,
antes de enviar el token por `POST /api/public/approval-access`. La página usa
metadatos de no indexación y no caché, con política de referencia `no-referrer`.
No conserva el token en almacenamiento del navegador ni lo muestra en errores.
Al validar el enlace, navega únicamente a `/dashboard/aprobaciones`; si falta o
ya no es válido, solicita volver a abrir un enlace vigente del administrador.

Cada apertura válida establece la cookie `approval_access_session` durante
**8 horas**. Esta cookie es independiente de la sesión administrativa: permite
abrir el acceso personal sin sustituir la sesión del administrador en el mismo
navegador. Las rutas de aprobaciones validan en base de datos, en cada petición,
la cuenta, el rol, la sede y el aliado central activos, la versión de credenciales
y el identificador vigente del enlace. Las decisiones siguen atribuidas al
usuario individual del analista.

Regenerar o revocar invalida el enlace anterior y las sesiones vinculadas a su
identificador (`grantId`). Restablecer la clave o desactivar la cuenta invalida
su acceso mediante `credentialVersion`. Iniciar una nueva sesión con usuario y
clave elimina la cookie de acceso por enlace. Cerrar sesión también elimina esa
cookie; volver a abrir un enlace que sigue vigente permite iniciar otra sesión.

### Revisión de un crédito

El flujo consiste en:

1. Abrir el enlace común y elegir un crédito del muro.
2. Revisar los valores, las cinco fotografías y la última página del PDF firmado.
3. Registrar novedades cuando algo requiera corrección y revisar las respuestas
   del aliado. Una novedad abierta impide aprobar; responder nunca aprueba solo.
4. Realizar la llamada al cliente y guardar su grabación para la revisión vigente.
5. Confirmar **OK para liquidación** cuando todo esté en orden. El crédito sale de
   Pendientes y queda en Aprobadas. Subir el audio no concede el OK.

### Grabación obligatoria antes del OK

La llamada la realiza el analista; el teléfono del cliente permite abrir la
aplicación de llamadas disponible en su dispositivo. El sistema recibe una
**grabación MP3, M4A o WAV de hasta 10 MiB**. La fecha mostrada es la de carga,
no una fecha de llamada inferida. El analista confirma que realizó la llamada
al conceder el OK; no se integra un proveedor de telefonía ni se graba automáticamente.

El audio se almacena de forma privada y separada del contrato. No se incorpora al
snapshot contractual ni a sus valores. Cada carga conserva su archivo, autor,
fecha, huella y revisión. Las cargas anteriores no se sobrescriben. Cambiar los
documentos e invalidar la revisión exige adjuntar la grabación de la nueva revisión.

El servidor valida contenido y contenedor, permisos, origen, revisión y huella;
la extensión por sí sola no es suficiente. El envío es binario, con límite durante
la lectura e identificador de operación para reintentos. Reproducir el audio exige
una sesión vigente, acceso al crédito y admite peticiones Range autenticadas.
No se generan URL públicas para los archivos ni se entrega audio en los listados.

El OK nuevo debe identificar la grabación vigente observada por el analista.
Otra carga concurrente invalida esa selección y requiere actualizar. Las
aprobaciones existentes conservan su estado aunque no tengan audio. Una aprobación
que se invalide deberá satisfacer los requisitos del nuevo OK.

Rutas adicionales:

- `GET /api/aprobaciones?view=approved`: aprobaciones vigentes; cursor exclusivo
  de esta vista por fecha de aprobación e identificador.
- `POST /api/aprobaciones/:id/grabaciones`: cuerpo binario y cabeceras
  `x-recording-file-name` (nombre codificado), `x-review-revision`,
  `x-review-hash` e `idempotency-key`.
- `GET /api/aprobaciones/:id/grabaciones/:recordingId`: reproducción privada.
- `POST /api/aprobaciones/:id`: incorpora `recordingId` al OK junto a revisión
  y huella. Un reintento de un OK previo no altera su grabación registrada.

### Novedades y PENDIENTES del aliado

El analista selecciona las fotografías rechazadas y escribe el motivo. También
puede crear una novedad general con respuesta textual. Cada foto conserva un
estado independiente. El administrador del aliado ve estas solicitudes en el
menú **PENDIENTES**, separado de Solicitudes, únicamente para su propio aliado.

Puede sustituir solo la foto señalada. Guardar una imagen realmente diferente
archiva la anterior y marca esa novedad como respondida en la misma transacción;
no existe otro botón para enviarla a revisión. Subir la misma foto no cuenta como
corrección. Una respuesta parcial vuelve a estar disponible al analista, pero
las demás fotos abiertas siguen bloqueando el OK y la liquidación.

El caso pasa de WAITING_ALLY a RESPONDED cuando todos sus elementos tienen
respuesta. Permanece en PENDIENTES con el estado de revisión, sin permitir
sustituir una foto ya respondida. El analista puede volver a señalar el problema,
conservando el historial. El OK cierra las novedades respondidas (RESOLVED) y
aprueba en una sola transacción; entonces desaparece de ambas vistas.

Los eventos registran motivo, actor, fechas y huellas. Las respuestas comparan la
versión del elemento y de la foto para evitar sobrescribir correcciones ajenas.
Los reintentos usan un identificador por acción, sin duplicar respuestas. Un
expediente histórico, importado exento, anulado o ya liquidado no recibe estas
nuevas acciones. La creación y cada respuesta invalidan la revisión anterior;
una novedad activa impide liquidar incluso mediante el control de PostgreSQL.

## Correcciones y nueva firma

Las acciones del analista se limitan a créditos nuevos sujetos a revisión, de
aliados externos, no anulados y sin liquidación pagada. No conceden acceso a la
fábrica, a cambios financieros ni a políticas. La corrección puede iniciarse
aunque falte una fotografía; no depende de que el crédito ya permita el OK.

### Fotografías

El analista selecciona una de las cinco imágenes, carga un PNG o JPEG, revisa su
vista previa y confirma el reemplazo. Se reutilizan la preparación del archivo y
la decodificación real de imágenes del flujo existente. No se admite contenido
activo ni imágenes que excedan los límites del normalizador.

La escritura bloquea primero el crédito y después su revisión. Compara la
revisión y huella observadas, archiva la imagen anterior y registra actor, fecha
y hashes en CreditApprovalEvidenceRevision, dentro de la misma transacción. Solo
cambia la fotografía elegida y sus metadatos de evidencia; conserva la parte
financiera y la firma del snapshot. Los eventos y versiones no pueden editarse
ni borrarse. No se reconstruyen versiones históricas que no existían antes.

Una foto distinta devuelve el expediente a pendiente; seleccionar la misma
imagen no invalida un OK vigente. Un conflicto o un resultado incierto obliga a
recargar, sin repetir automáticamente el reemplazo. La corrección administrativa
existente conserva sus permisos y comparte la escritura transaccional y archivo.
Ambas rutas rechazan cambios mientras haya una nueva firma en curso.

### Reenviar un folio mal firmado

El analista indica el motivo y confirma una nueva solicitud para el mismo folio.
Se comprueba la versión del proceso original y el sello financiero conservado en
el crédito y en el proceso firmado. Si faltan datos o sus condiciones difieren,
se rechaza la acción antes de enviar al proveedor; no se reconstruyen términos
mediante una nueva política o evaluación de riesgo.

CreditApprovalReissue conserva el contrato y PDF anteriores, sus hashes, el
actor, el motivo y los datos congelados para la nueva firma. El primer documento
base se prepara con esos datos comprobados; no se promete igualdad binaria con
un PDF sin firmar que no se conservó. Las solicitudes sucesivas reutilizan la
base documental congelada. El PDF firmado anterior nunca se reescribe.

La reserva persistente invalida el OK antes de contactar a FirmaSeguro. El envío
usa un identificador idempotente y no se repite automáticamente ante un resultado
incierto. El botón Consultar nueva firma consulta el proceso vigente. Una
respuesta antigua no puede restablecer el proceso o el contrato anterior.

Los estados de la operación son PREPARING, DISPATCHING, AWAITING_SIGNATURE,
COMPLETED, FAILED_SAFE y UNCERTAIN. Los estados en curso o inciertos bloquean
aprobación y liquidación también en PostgreSQL. FAILED_SAFE significa que no se
llamó al proveedor y permite otro intento explícito. Un envío de resultado
incierto requiere verificación administrativa; no autoriza otro envío a ciegas.
Recibir el nuevo PDF no aprueba el crédito: el analista debe revisarlo y dar otro
OK. La pantalla sigue mostrando solamente la última página del documento vigente.

### Estado del reporte

El reporte de créditos y su Excel muestran APROBADO únicamente cuando el OK
corresponde a la revisión vigente, sobre estados operativos GENERADO, INSCRITO o
ENTREGABLE. Conservan la prioridad de anulaciones, cancelaciones, paz y salvo,
bloqueos y estados no reconocidos. Los créditos históricos sin revisión conservan
su etiqueta. El dato estadoReporte es de presentación: Credito.estado, los
importes, filtros y reglas financieras permanecen independientes. La etiqueta se
actualiza al abrir el reporte o volver a consultar con Aplicar.

## Información revisada

| Dato | Fuente y tratamiento |
| --- | --- |
| Score | Evaluación DataCrédito consumida y vinculada al crédito; se respeta el identificador guardado en el contrato cuando existe. `-1` se presenta como **Sin información**, sin inventar un puntaje. |
| Nombre, cédula, correo y teléfono | Datos de contacto guardados en el propio crédito. Los campos vacíos se muestran como **No disponible**. |
| Inicial | `Credito.cuotaInicial`; es el valor registrado en el crédito. |
| Crédito autorizado | Capital registrado en `saldoBaseFinanciado`, con el respaldo existente de valor del equipo menos inicial. |
| Valor venta | `Credito.valorEquipoTotal`, mostrado como importe independiente. |
| Plazo de financiación | `Credito.plazoMeses` guarda cantidad de cuotas, junto con `frecuenciaPago`; por ejemplo, **12 cuotas · Quincenal**. No se interpreta automáticamente como meses. |
| Valor de cuota | Cuota comercial persistida en `CreditoAmortizacion`; si no existe, `contratoSnapshot.financiero.cuotaComercial` y finalmente `Credito.valorCuota`. No se recalcula ni redondea el crédito al consultar. |
| Fecha primer pago | `Credito.fechaPrimerPago`, conservando el día calendario UTC. No se sustituye por la fecha del próximo pago. |
| Cinco fotografías | Cédula frontal, cédula posterior, selfie con cédula, entrega y remisión guardadas en el crédito. |
| PDF firmado | Proceso FirmaSeguro vigente, no sustituido, asociado al crédito y con documento firmado disponible; el visor muestra su última página. |

El resumen ya no muestra **Cupo aprobado** ni el porcentaje de inicial de la oferta. Los datos opcionales inválidos o ausentes no se convierten en cero ni en fechas actuales. Esta ampliación de lectura no modifica contratos, amortización, aprobaciones existentes ni el esquema de la base.

El visor utiliza PDF.js y sus recursos servidos por la propia aplicación, sin
CDN. Obtiene internamente el PDF completo mediante la ruta autorizada y renderiza
su última página en el navegador. Los bytes y la huella del documento original
se conservan intactos; no se extrae ni se guarda un PDF derivado.

El módulo consulta el puntaje y la oferta operativa, sin descifrar el payload del
proveedor ni iniciar otra consulta de riesgo o proceso de firma. Una evaluación
de otra cédula o de otro crédito no se usa como sustituto. Si falta información,
la pantalla lo indica; una evaluación vinculada no disponible, fotografías
faltantes o inválidas y un documento sin firma impiden un nuevo OK. También se
rechaza la aprobación de créditos anulados, cancelados, ya pagados o que no
cumplen las comprobaciones financieras del módulo.

La retención de DataCrédito se conserva. Una evaluación ya purgada se muestra
como no disponible y no se reconstruye consultando al proveedor. La purga no
revoca una aprobación ya registrada.

## Activación y conservación del historial

La activación queda fijada en la **primera instalación correcta del script de
esquema durante un despliegue autorizado**. Crear una rama, subirla a GitHub o
ejecutar las pruebas sin ese despliegue no activa la regla en producción.

`scripts/railway-predeploy.mjs` incorpora
`scripts/ensure-credit-approval-schema.mjs`, que instala el esquema aditivo de
`scripts/credit-approval-schema.mjs`. La instalación es transaccional y guarda
una única fila en `CreditApprovalPolicy`, con `activatedAt` como corte duradero
en UTC. Las ejecuciones posteriores conservan ese valor; no lo reemplazan por
una fecha de configuración ni reclasifican todo el historial.

El mismo predespliegue instala el esquema de enlaces personales mediante
`scripts/ensure-approval-access-schema.mjs` y
`scripts/approval-access-schema.mjs`. Esta instalación aditiva conserva el corte
existente de `CreditApprovalPolicy` y las reglas de revisión del historial.

Se exige revisión a los créditos creados desde ese corte, según
`Credito.createdAt`, y que no tengan simultáneamente los marcadores de
importación masiva `equalityService = IMPORTACION_MASIVA` y
`contratoSnapshot.origen.tipo = IMPORTACION_MASIVA`. Una observación escrita a
mano no concede esa exención. Una vez que un crédito tiene registro de revisión,
conserva el requisito aunque después cambien su fecha o los marcadores de origen.

Los créditos anteriores al corte y los importados masivamente exentos conservan
sus reglas de liquidación. La instalación no rellena aprobaciones históricas,
reescribe créditos, modifica contratos firmados ni recalcula liquidaciones
pagadas. Si falta el esquema o la política, la aplicación no habilita una
liquidación saltándose el control: la operación falla y debe completarse la
preparación del entorno.

## Revisión, auditoría y concurrencia

`CreditApprovalReview` conserva el estado y la revisión actual. El OK registra
tipo de actor, usuario individual o grant/sesión compartidos, nombre, fecha,
revisión aprobada y una huella de los datos consultados.
`CreditApprovalEvent` conserva eventos de aprobación e invalidación. Los eventos
y la fecha de activación están protegidos contra modificación y eliminación.

El cliente envía la revisión y la huella que mostró al analista. El servidor
vuelve a leer el crédito, evaluación y documento dentro de la transacción. Si el
expediente cambió, responde `409`: la pantalla actualiza el detalle y exige una
nueva revisión y confirmación explícita. No reintenta aprobar automáticamente.
Repetir una aprobación confirmada de la misma revisión es idempotente: no duplica
el evento ni sustituye al analista original.

Los cambios relevantes de identidad, importes, equipo, fotografías, secciones
financieras o de firma del contrato, y el documento de FirmaSeguro invalidan la
revisión pendiente de pago. La reasignación de una sede a otro aliado también
invalida sus revisiones correspondientes. La invalidación incrementa la revisión,
la devuelve a pendiente y conserva el evento anterior. Los créditos incluidos en
una liquidación pagada se preservan.

La selección y creación de liquidaciones comprueba la revisión vigente. Además,
un trigger de PostgreSQL impide insertar en `LiquidacionAliadoCredito` un crédito
que necesita el OK y no lo tiene. Los bloqueos coordinan aprobación, correcciones
y liquidación; un conflicto exige volver a consultar el estado. El OK no elimina
las demás reglas de elegibilidad de pagos a aliados.

## Contrato HTTP

Las rutas del expediente autentican y autorizan antes de consultar datos.
La administración de enlaces requiere una sesión de administrador central; el
canje público valida el token personal y su vigencia. Las respuestas, incluidas
las fotografías y el PDF, usan `Cache-Control: private, no-store` y
`X-Content-Type-Options: nosniff`.

| Método y ruta | Uso |
| --- | --- |
| `GET /api/aprobaciones?view=pending&cursor=...` | Muro paginado: `items`, `nextCursor`, `hasMore`. La búsqueda exacta anterior solo se conserva para sesiones individuales compatibles. |
| `GET/POST /api/aprobaciones/[id]/novedades` | Consulta estado/historial o registra fotografías y motivo con revisión e idempotencia. |
| `GET /api/pendientes` y `GET /api/pendientes/[id]` | Lista y detalle de novedades del propio aliado. |
| `POST /api/pendientes/[id]/evidencias` o `/respuesta` | Responde el elemento solicitado, con versión e idempotencia. |
| `GET/POST/DELETE /api/aprobaciones/enlace-comun` | Administración central del enlace común. |
| `POST /api/public/approval-shared-access` | Canje del enlace común por una sesión independiente. |
| `GET /api/aprobaciones/[id]` | Devuelve `item` con información financiera, `review`, disponibilidad de documentos, `canApprove` y `blockingReasons`. |
| `PATCH /api/aprobaciones/[id]/evidencias` | Reemplaza una fotografía con key, dataUrl, revision y reviewHash. |
| `POST /api/aprobaciones/[id]/firma-seguro` | Solicita otra firma (REQUEST) o consulta su estado (REFRESH). |
| `POST /api/aprobaciones/[id]` | Recibe únicamente `{revision, reviewHash}`; confirma el OK con el actor de la sesión. |
| `GET /api/aprobaciones/[id]/evidencias?tipo=...` | Entrega una de las cinco fotografías permitidas. |
| `GET /api/aprobaciones/[id]/documento` | Entrega el PDF firmado vigente completo para renderizar localmente su última página. |
| `GET /api/usuarios/analistas/[id]/enlace` | Consulta el estado del enlace personal y su URL cuando está vigente. |
| `POST /api/usuarios/analistas/[id]/enlace` | Genera o regenera el enlace; recibe `{expectedGrantId}`, con `null` para la primera generación. |
| `DELETE /api/usuarios/analistas/[id]/enlace` | Revoca el enlace indicado por `{expectedGrantId}`. |
| `POST /api/public/approval-access` | Recibe `{token}`, valida el origen de la petición y establece la cookie de acceso personal. |

La consulta y las mutaciones de enlaces devuelven
`{ok, active, hasLink, grantId, accessUrl, createdAt}`. `active` indica que el
enlace permite acceder; `accessUrl` es `null` si no está vigente. Las mutaciones
comparan `expectedGrantId` con el identificador almacenado: un cambio concurrente
produce `409` y requiere consultar de nuevo antes de tomar otra decisión. El
canje devuelve `{ok: true, destination: "/dashboard/aprobaciones"}`.

Los códigos principales son `401` sin sesión, `403` sin permiso o con origen no
permitido, `400` para entradas inválidas, `404` para recursos no encontrados,
`409` para revisión cambiada o documento aún no disponible y `503` cuando no se
puede verificar el expediente. No se exponen consultas SQL ni detalles internos
en los mensajes de error.

## Pruebas

Ejecutar la suite del módulo desde la carpeta del proyecto:

```powershell
npm run test:aprobaciones
```

Incluye permisos de analistas, servicio, API, cliente, selección de liquidación,
esquema y regresiones del flujo. Las pruebas del visor comprueban la selección y
renderizado de la última página, la conservación del documento original, los
límites de tamaño y la cancelación de cargas.

Las pruebas de PostgreSQL son opcionales sin conexión configurada y quedan
marcadas como omitidas. Para ejecutarlas se debe
preparar una base **local y exclusiva de fixtures** llamada `approval_test`:

```powershell
$env:CREDIT_APPROVAL_TEST_DATABASE_URL = "<conexión PostgreSQL local a approval_test>"
npm run test:aprobaciones
```

La prueba valida que el host sea local y el nombre de base sea `approval_test`.
Reinicia las tablas de sus fixtures; esa conexión no debe contener trabajo real.
Comprueba corte de activación, exenciones, auditoría, invalidación y concurrencia
de liquidaciones. La suite no requiere credenciales de producción.

La suite específica de enlaces personales se ejecuta con:

```powershell
node --test tests/approval-access*.test.mjs
```

Comprueba autenticación, permisos, generación, reutilización, rotación,
revocación, invalidación por credenciales y la cookie de 8 horas. Su prueba
PostgreSQL requiere otra base **local y exclusiva de fixtures**, llamada
`approval_access_test`:

```powershell
$env:APPROVAL_ACCESS_TEST_DATABASE_URL = "<conexión PostgreSQL local a approval_access_test>"
node --test tests/approval-access*.test.mjs
```

Sin esa variable, la prueba PostgreSQL queda omitida. Valida el host y el nombre
de base antes de reiniciar fixtures; comprueba unicidad, revocación, instalación
repetible y conservación del corte de activación.

La comprobación de interfaz debe incluir el muro, paginación y varios folios,
documentación completa y faltante, ampliación de fotos, carga y zoom de la última
página del PDF, confirmación del OK, revisión obsoleta y errores que conservan la
selección. Para los enlaces, comprobar generación y reutilización, copia con
portapapeles restringido, confirmación de regeneración y revocación, cuenta
desactivada y clave restablecida, fragmento retirado antes del canje, apertura sin
token, un solo canje en StrictMode y coexistencia con la sesión administrativa.

Las pruebas de corrección y reemisión deben cubrir permisos por contraseña y
enlace, imagen anterior intacta, MIME/tamaño, revisión obsoleta, doble envío,
respuesta perdida, callback antiguo, igualdad del folio y condiciones, bloqueo
concurrente de aprobación/liquidación y el nuevo OK. La validación del proveedor
se realiza con fixtures y respuestas simuladas, sin enviar firmas a clientes.

Las pruebas PostgreSQL de fotos y reemisión usan dos bases adicionales locales,
exclusivas de fixtures; cada suite verifica host y nombre antes de crear o reiniciar
sus tablas. No deben contener información real:

```powershell
$env:CREDIT_APPROVAL_EVIDENCE_TEST_DATABASE_URL = "<conexión PostgreSQL local a approval_evidence_test>"
$env:CREDIT_APPROVAL_REISSUE_TEST_DATABASE_URL = "<conexión PostgreSQL local a approval_reissue_test>"
npm run test:aprobaciones
node --test tests/credit-report-status.test.mjs tests/credit-report-excel.test.mjs
npm run test:firmaseguro
```

La revisión en navegador incluye que la foto nueva se vea inmediatamente, que
el reporte pase de APROBADO a su estado operativo al corregir el expediente y
que vuelva a APROBADO únicamente después del nuevo OK.


El predespliegue conserva los instaladores anteriores e incorpora, en orden,
`ensure-credit-approval-actor-schema.mjs`,
`ensure-credit-approval-novelties-schema.mjs` y
`ensure-approval-shared-schema.mjs`. Las claves compartidas se incorporan después
de sus columnas. Al final se ejecuta `ensure-credit-approval-call-schema.mjs`,
que instala la tabla de audio y la barrera para nuevos OK. La instalación aditiva
conserva la activación, aprobaciones y contratos previos; las filas históricas mantienen su autor individual.

Las suites adicionales de PostgreSQL exigen bases locales exclusivas:

| Variable | Base |
| --- | --- |
| CREDIT_APPROVAL_ACTOR_TEST_DATABASE_URL | approval_actor_test |
| APPROVAL_SHARED_TEST_DATABASE_URL | approval_shared_test |
| CREDIT_NOVELTIES_TEST_DATABASE_URL | approval_novelties_test |

Verificar el recorrido común → novedad en dos fotos → PENDIENTES propio → primera
foto respondida con otra aún abierta → segunda respuesta → nuevo OK → desaparición
de ambas listas. Incluir otro aliado sin permiso, un enlace revocado, contratos y
fotos anteriores intactos, y respuestas simultáneas. Todo se valida con datos y
proveedor de firma sintéticos, sin contactar clientes.

## Validación de grabaciones y aprobaciones vigentes

El despliegue debe instalar primero el esquema del audio y luego iniciar la
versión que envía `recordingId`. No hay backfill ni cambio de la fecha original
que decide qué créditos requieren revisión. La instalación se puede repetir;
conserva las decisiones existentes y sus documentos. Una versión anterior de la
aplicación que no envíe audio no podrá conceder nuevos OK después de esta instalación.

Las pruebas adicionales de PostgreSQL usan bases locales exclusivas de fixtures:

| Variable | Base |
| --- | --- |
| CREDIT_APPROVAL_QUEUE_TEST_DATABASE_URL | approval_queue_test |
| CREDIT_APPROVAL_CALL_TEST_DATABASE_URL | approval_call_test |
| CREDIT_APPROVAL_CALL_GATE_TEST_DATABASE_URL | approval_gate_test |

Cubren instalación repetida y después de Prisma, aprobaciones previas sin audio,
checksum/tamaño/autoría, inmutabilidad, invalidación, selección de la última
carga y las carreras entre subir, sustituir y aprobar. El OK sin audio se rechaza
en el servicio y en SQL; liquidación continúa usando su bloqueo existente.

Verificar en navegador el enlace común, ambas pestañas, novedad de fotografía,
respuesta desde PENDIENTES del aliado, carga del audio sin aprobación automática,
OK explícito, expediente aprobado en lectura y reproducción autenticada con
Range. Revisar recuperación de cargas fallidas y reproducción, escritorio y
celular, y que contratos, condiciones y aprobaciones históricas permanezcan intactos.
