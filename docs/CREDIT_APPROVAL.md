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
Los vendedores, administradores de aliados y usuarios sin sesión no pueden
consultar el expediente ni abrir sus fotografías o documentos.

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

1. Buscar la cédula completa. La búsqueda es exacta y está limitada a créditos de
   aliados distintos de FINSER PAY.
2. Elegir el folio cuando el cliente tiene varios créditos.
3. Revisar el resumen financiero, las cinco fotografías y la última página del
   PDF firmado de FirmaSeguro. Las imágenes se pueden ampliar y la página del
   contrato se consulta en el visor integrado.
4. Pulsar **OK para liquidación** y confirmar la identidad y el folio mostrados.

El flujo tiene dos estados: **Pendiente de revisión** (`PENDING`) y **Aprobado**
(`APPROVED`). No existe una acción de devolver o rechazar el crédito. La etiqueta
**No requiere aprobación** (`NOT_REQUIRED`) identifica créditos exentos; no es
un tercer estado de decisión del analista. Las fotografías y los contratos son
de solo lectura en este panel.

## Información revisada

| Dato | Fuente y tratamiento |
| --- | --- |
| Score | Evaluación DataCrédito consumida y vinculada al crédito; se respeta el identificador guardado en el contrato cuando existe. `-1` se presenta como **Sin información**, sin inventar un puntaje. |
| Porcentaje aprobado en la oferta | `offer.initialPaymentPercentage` de esa evaluación. Puede diferir del porcentaje efectivamente pagado por el cliente. |
| Inicial aplicada | `Credito.cuotaInicial`; es el valor registrado en el crédito. |
| Crédito autorizado | Capital registrado en `saldoBaseFinanciado`, con el respaldo existente de valor del equipo menos inicial. |
| Cupo aprobado | Valor guardado en los términos DataCrédito del contrato; la oferta es el respaldo cuando esos términos no lo contienen. |
| Cinco fotografías | Cédula frontal, cédula posterior, selfie con cédula, entrega y remisión guardadas en el crédito. |
| PDF firmado | Proceso FirmaSeguro vigente, no sustituido, asociado al crédito y con documento firmado disponible; el visor muestra su última página. |

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
usuario, nombre, fecha, revisión aprobada y una huella de los datos consultados.
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
| `GET /api/aprobaciones?documento=...` | Búsqueda exacta; devuelve `items` con los folios encontrados. |
| `GET /api/aprobaciones/[id]` | Devuelve `item` con información financiera, `review`, disponibilidad de documentos, `canApprove` y `blockingReasons`. |
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

La comprobación de interfaz debe incluir búsqueda con uno y varios folios,
documentación completa y faltante, ampliación de fotos, carga y zoom de la última
página del PDF, confirmación del OK, revisión obsoleta y errores que conservan la
selección. Para los enlaces, comprobar generación y reutilización, copia con
portapapeles restringido, confirmación de regeneración y revocación, cuenta
desactivada y clave restablecida, fragmento retirado antes del canje, apertura sin
token, un solo canje en StrictMode y coexistencia con la sesión administrativa.
