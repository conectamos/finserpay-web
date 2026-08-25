# Integracion DataCredito MiDecisor

## Alcance

Esta integracion cubre exclusivamente la consulta de persona natural para la
precalificacion de una venta Android o iPhone. MiDecisor entrega informacion de
riesgo y un puntaje; FINSER PAY aplica una politica interna versionada para
producir la decision y la oferta.

No forman parte de este alcance:

- reporte de obligaciones a centrales de riesgo;
- validacion biometrica o documental (continua a cargo del flujo Veriff);
- uso directo del `montoSugerido` de Experian para calcular la oferta;
- cambios a Wompi, Efecty, Zero Touch, FirmaSeguro o la aplicacion Android.

## Flujo operativo

1. El asesor elige Android o iPhone.
2. Registra cedula y primer apellido.
3. Confirma que el titular autorizo la consulta antes de ejecutarla.
4. El servidor consulta MiDecisor, valida el puntaje y construye el resumen
   normalizado del sector TELCOS.
5. Si TELCOS está informado y su mora vigente agregada en COP supera el umbral
   configurado para la plataforma consultada, se aplica
   `TELCO_DELINQUENCY_THRESHOLD` y el flujo termina con `NO APROBADO` antes
   de evaluar el puntaje. La prioridad es igual para Android e iPhone, pero cada
   plataforma conserva su propio umbral.
6. Si TELCOS no está informado, o su mora válida no supera el umbral de la
   plataforma, el servidor resuelve la banda de puntaje vigente.
7. Si la banda rechaza, el flujo termina con `NO APROBADO`.
8. Si la banda aprueba, se fijan la cuota inicial, la fianza y el credito
   maximo de esa banda; luego se abre la validacion de identidad existente.
9. Al crear el credito, el servidor vuelve a validar y consume la evaluacion;
   el navegador nunca decide ni puede modificar la banda aplicada.

Una falla tecnica, una respuesta parcial o un puntaje ausente, malformado o
fuera de rango se presenta como `No se pudo evaluar`; nunca se convierte en
aprobacion ni rechazo. Solo una respuesta `ACCEPTED` con codigo `TX=17`, o con
`TX=01..08` y `conInformacion=false` explicito, activa la regla comercial
`Sin informacion`. Si el sector TELCOS está marcado como disponible pero su
`saldoMora` es nulo, negativo, fraccionario, excede el rango seguro o no puede
normalizarse a COP, también se devuelve un error técnico; no se interpreta como
mora cero ni como rechazo.

## Contrato MiDecisor usado

Solicitud de persona natural:

```json
{
  "tipoIdentificacion": "1",
  "numeroIdentificacion": "<cedula de 3 a 13 digitos>",
  "apellidoRazonSocial": "<primer apellido>"
}
```

La ruta de consulta queda configurable porque los documentos recibidos no son
consistentes entre `/co/cs/midecisor/v1/client` y
`/co/cs/midecisor/v1/pn`. El valor predeterminado es la ruta unificada
`/co/cs/midecisor/v1/client` y debe confirmarse en certificacion.

La autenticacion obtiene un JWT con `POST /spla/oauth2/v1/token`, enviando
`client_id` y `client_secret` en headers, y `username` y `password` en JSON.
El token solo se conserva en memoria, respetando `expires_in`; no se persiste ni
se registra.

## Unidad monetaria de indicadores MiDecisor PN

FINSER PAY versiona la interpretación confirmada como
`MIDECISOR_PN_MILES_COP_V1`. DataCrédito Experian indica oficialmente que los
cupos, saldos y moras por sector de MiDecisor se expresan en miles:

https://www.datacredito.com.co/empresas/midecisor-empresas

Por tanto, los campos monetarios de `indicadoresValores`, sus `sectores`,
`evolucionSaldoCuotaPN` y `evolucionRoPN` se convierten a pesos colombianos
multiplicando el valor informado por 1.000. Por ejemplo, `saldoMora: 359`
equivale a `$359.000 COP`.

La conversión solo se aplica a valores monetarios: valor inicial, saldo, cuota,
mora y cupo. Los conteos y porcentajes conservan la unidad informada. El payload
original permanece intacto dentro del expediente cifrado; la normalización se
realiza al construir el resumen derivado, por lo que también corrige la lectura
de expedientes históricos sin reescribirlos ni generar una nueva consulta.

La regla prioritaria usa exclusivamente
`summary.telcos.delinquentBalance`: la mora vigente agregada de la fila sectorial
identificada como TELCOS. No usa `summary.totals.delinquentBalance`, no suma mora
de otros sectores y no infiere una mora TELCOS cuando ese sector no está
reportado. El contrato de unidades sigue siendo
`MIDECISOR_PN_MILES_COP_V1` porque versiona la conversión monetaria, no el
agregado de riesgo elegido por la política.

Por cautela, `montoSugerido` e `ingreso` no se convierten con esta regla hasta
confirmar de forma específica su unidad contractual con Experian.

## Separación de ambientes

Las respuestas de DEMO, sandbox, certificación o UAT usan datos de prueba y no
autorizan ventas reales, aunque MiDecisor devuelva un puntaje o una decisión
aprobada. En una ejecución con `NODE_ENV=production`, el servidor exige que
`DATACREDITO_ENVIRONMENT` sea `prod` o `production` antes de consultar al
proveedor. Este guard está activo por defecto y una discrepancia responde como
error técnico, no como rechazo.

`DATACREDITO_ALLOW_NON_PRODUCTION_PROVIDER=true` es un override excepcional
para pruebas controladas de certificación sobre un despliegue construido en modo
producción. Debe permanecer ausente o en `false` para ventas reales y nunca
convierte datos DEMO/UAT en información válida para originar créditos.

## Variables de entorno

Todas son variables exclusivas del servidor. Ninguna debe usar el prefijo
`NEXT_PUBLIC_` ni guardarse en Git, imagenes, logs o archivos del repositorio.

| Variable | Uso |
| --- | --- |
| `DATACREDITO_QUERY_ENABLED` | Activa el requisito de precalificacion. Por defecto debe ser `false`. |
| `DATACREDITO_ENVIRONMENT` | Ambiente real del proveedor. Solo `prod` o `production` habilitan ventas en una ejecución productiva. |
| `DATACREDITO_ALLOW_NON_PRODUCTION_PROVIDER` | Override excepcional para certificación controlada sobre un build productivo. Debe quedar ausente o `false` en ventas reales. |
| `DATACREDITO_AUTH_BASE_URL` | Host HTTPS confirmado para autenticacion. |
| `DATACREDITO_API_BASE_URL` | Host HTTPS confirmado para MiDecisor. |
| `DATACREDITO_CLIENT_ID` | Identificador confidencial del cliente. |
| `DATACREDITO_CLIENT_SECRET` | Secreto confidencial del cliente. |
| `DATACREDITO_USERNAME` | Usuario confidencial de Experian. |
| `DATACREDITO_PASSWORD` | Contrasena confidencial de Experian. |
| `DATACREDITO_TOKEN_PATH` | Ruta del token; predeterminado `/spla/oauth2/v1/token`. |
| `DATACREDITO_QUERY_PATH` | Ruta de consulta; predeterminado `/co/cs/midecisor/v1/client`. |
| `DATACREDITO_TIMEOUT_MS` | Tiempo maximo por solicitud saliente. |
| `DATACREDITO_RESPONSE_MAX_BYTES` | Tamano maximo aceptado de una respuesta. |
| `DATACREDITO_AUDIT_HMAC_SECRET` | Llave aleatoria separada para seudonimizar datos de auditoria. |
| `DATACREDITO_RECORD_ENCRYPTION_KEYS_JSON` | Keyring JSON servidor, con uno o más identificadores y claves AES de 32 bytes codificadas en base64. |
| `DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID` | Identificador de la clave del keyring usada para cifrar expedientes nuevos. |
| `DATACREDITO_ASSESSMENT_TTL_MINUTES` | Variable histórica ignorada por el runtime nuevo. La vigencia contractual es fija: 21.600 minutos (15 días), sin ventana deslizante. |
| `DATACREDITO_RETENTION_DAYS` | Retención de la evaluación, su expediente cifrado y las auditorías asociadas. Mínimo 15 días; recomendado 90 días. |
| `DATACREDITO_RETENTION_TOKEN` | Token aleatorio de al menos 32 bytes para el cron de eliminacion por retencion. Puede usarse `CRON_SECRET` como respaldo. |
| `DATACREDITO_RATE_LIMIT_MAX` | Maximo de intentos en 15 minutos por usuario o cedula seudonimizada dentro de la sede. |

`DATACREDITO_AUDIT_HMAC_SECRET` no debe reutilizar la clave de sesion ni otra
credencial. Debe tener al menos 32 bytes aleatorios y rotarse mediante un plan
que contemple los hashes historicos.

### Keyring del expediente

El keyring debe configurarse en el gestor de secretos del ambiente antes de
activar `DATACREDITO_QUERY_ENABLED`. Su formato es un objeto JSON; cada valor es
una clave aleatoria de exactamente 32 bytes codificada en base64:

```json
{
  "dc-2026-08": "<base64 de 32 bytes>",
  "dc-anterior": "<base64 de 32 bytes>"
}
```

`DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID` debe coincidir con una clave del
objeto, por ejemplo `dc-2026-08`. La clave activa cifra registros nuevos; las
claves anteriores deben conservarse en el keyring mientras existan expedientes
cifrados con ellas. Retirar una clave antes de que termine la retención hace
irrecuperables esos expedientes. No se deben imprimir, copiar al repositorio ni
reutilizar estas claves como HMAC, sesión o credenciales de Experian.

## Perfiles de política por aliado

El administrador central puede crear varios perfiles nombrados y asignar
exactamente uno a cada aliado. Cada guardado crea una revisión inmutable dentro
del perfil; reasignar un aliado solo afecta consultas futuras. La evaluación
guarda tanto la versión como el identificador de revisión que emitió la oferta,
por lo que un crédito ya evaluado no cambia si después se publica o asigna otra
política.

El perfil fijo `Política general` recibe, de forma idempotente, todas las
versiones de la tabla global legado y queda asignado a aliados existentes o
nuevos durante la migración. La tabla legado y un trigger de sincronización se
conservan durante el despliegue blue-green. Este perfil técnico no inventa una
oferta: sin una revisión activa y válida, la aplicación responde `503` antes de
contactar a Experian.

Cada revisión contiene bandas separadas para `ANDROID` e `IPHONE`:

```json
{
  "id": "identificador-estable",
  "platform": "ANDROID",
  "scoreMin": 0,
  "scoreMax": 950,
  "decision": "APROBADO",
  "initialPaymentPercentage": 20,
  "suretyPercentage": 60,
  "maxFinancedAmount": 1800000
}
```

Además, cada revisión nueva contiene una regla prioritaria única, anterior a
las bandas, con un umbral independiente para cada plataforma:

```json
{
  "priorityRules": {
    "telcoDelinquency": {
      "enabled": true,
      "rejectAboveCopByPlatform": {
        "ANDROID": 2000000,
        "IPHONE": 1000000
      }
    }
  }
}
```

Cada umbral es un entero en COP. La comparación es estricta: una mora TELCOS
exactamente igual al umbral de la plataforma continúa a la banda; solo un valor
superior produce `TELCO_DELINQUENCY_THRESHOLD`. La oferta auditada conserva el
umbral que se aplicó a esa evaluación. Esta decisión es independiente del
puntaje.

Una revisión histórica con el campo escalar `rejectAboveCop` se normaliza
únicamente en memoria usando ese mismo valor para Android e iPhone; el JSON
histórico no se reescribe. Una revisión sin
`priorityRules.telcoDelinquency` continúa con sus bandas. La administración no
activa la regla silenciosamente y exige publicar una nueva revisión para
incorporarla.

La administracion exige cobertura completa de 0 a 950 para cada plataforma,
sin huecos ni solapes, y exactamente una regla `Sin informacion` adicional por
plataforma. Esa regla se serializa internamente como el rango `-1..-1`; `-1` no
es un puntaje de Experian, nunca se acepta desde el campo `score` del proveedor
y no se muestra al asesor. Guardar genera una revisión nueva. Los umbrales, la
decisión, la inicial, la fianza y el crédito máximo siguen siendo una definición
comercial explícita de FINSER PAY; el perfil general solo conserva y asigna esa
configuración.

### API administrativa

`GET /api/creditos/datacredito/politicas` devuelve el catálogo completo de
perfiles, su última revisión, `revisionCreatedAt`, aliados y estado público del
proveedor. `POST` crea un perfil con su revisión 1 y devuelve
`createdPolicyId`. `PATCH` admite:

- `SAVE_REVISION` con `policyId`, `expectedVersion`, `bands`,
  `financialSettings` y `priorityRules`;
- `ASSIGN_ALLY` con `allyId`, `policyId` y `expectedPolicyId`.

Ambas mutaciones usan concurrencia optimista. Los conflictos devuelven `409`
con `POLICY_VERSION_CONFLICT` o `POLICY_ASSIGNMENT_CONFLICT`. Crear nombres
duplicados devuelve `POLICY_NAME_CONFLICT`. El catálogo y todas sus mutaciones
son exclusivos del administrador central; cada reasignación conserva actor,
perfil anterior, perfil nuevo y fecha en una auditoría inmutable.

`maxFinancedAmount` es un entero en pesos colombianos. Cuando el valor del
equipo supera el tope efectivo, el excedente se suma obligatoriamente a la
cuota inicial. El tope efectivo es el menor entre la banda DataCredito y la
salvaguarda vigente de catalogo, plataforma o iPhone. La formula aplicada tanto
en pantalla como en el servidor es:

`inicial minima = porcentaje * min(valor equipo, tope efectivo) + max(0, valor equipo - tope efectivo)`.

## Reutilización de consultas durante 15 días

Una respuesta terminal `APROBADO` o `RECHAZADO` se reutiliza durante 15 días
para la misma cédula, ambiente de proveedor y aliado, aunque cambien apellido,
asesor, sede o plataforma. El apellido y el consentimiento se vuelven a exigir.
Si identidad y scope coinciden exactamente se devuelve el mismo assessment; si
cambia alguno, se crea una fila operativa actual enlazada al inquiry raíz, sin
duplicar el expediente cifrado ni llamar otra vez a Experian.

Si cambia Android/iPhone, el servidor toma del inquiry raíz el puntaje y el
resumen TELCOS ya cifrado, y recalcula la decisión/oferta con la plataforma
solicitada usando la misma revisión histórica. No genera una consulta nueva y
conserva el vencimiento original, de modo que reutilizar no extiende la ventana.
Una revisión histórica sin la regla TELCOS continúa por banda. Un cambio de
aliado o ambiente no comparte el resultado.
Un resultado consumido no puede reutilizarse ni reclamarse de nuevo. Claim y
consumo bloquean y marcan atómicamente todo el grupo raíz/clones para impedir un
segundo crédito sobre la misma consulta.

## Protección, expediente y auditoría

- La fila operativa de la evaluación no guarda cédula ni apellido en claro:
  conserva HMAC, últimos cuatro dígitos, decisión, oferta, versión de política y
  metadatos técnicos minimizados.
- La cédula completa, el primer apellido y la respuesta de MiDecisor sí se
  conservan como un expediente separado, cifrado en reposo con AES-256-GCM. El
  cifrado usa nonce aleatorio, etiqueta de autenticación y datos autenticados
  asociados al identificador de evaluación, correlación, versión y clave.
- El expediente solo se descifra bajo demanda para el administrador central de
  FINSER PAY. El módulo `/dashboard/datacredito` lista consultas con documento
  enmascarado y permite abrir el detalle completo según la retención vigente.
  Cuando aplica el rechazo TELCOS, el listado y el detalle muestran la causa,
  la mora sectorial normalizada y el umbral de la revisión.
- Cada apertura del expediente central genera una auditoría con actor,
  correlación, resultado del acceso e IP/agente de usuario seudonimizados.
- IP y agente de usuario se conservan como HMAC, no en claro.
- El asesor no recibe el puntaje, la respuesta completa, la mora TELCOS ni los
  umbrales.
- Los errores públicos incluyen un identificador de correlación, no detalles de
  credenciales, claves de cifrado ni del proveedor.
- Cada evaluación operativa se vincula a usuario, asesor, aliado, sede,
  apellido y plataforma actuales. La reutilización nunca entrega directamente
  una fila de otro contexto: crea un clon auditable y reclamable para el scope
  actual, enlazado al inquiry raíz.
- Las llamadas tienen timeout y límite de bytes. Solo un `401` permite renovar
  el token y repetir una vez; no se reintentan consultas ambiguas.
- En producción la aplicación no crea ni altera tablas o índices. Solo verifica
  mediante catálogos PostgreSQL que el preflight fue aplicado y responde `503`
  si el esquema no está listo.

Las evaluaciones creadas antes de habilitar el expediente cifrado mantienen su
auditoría minimizada, pero su cédula completa y respuesta histórica no se pueden
recuperar. El módulo central las identifica como históricas sin expediente y no
ejecuta una nueva consulta pagada para reconstruirlas.

Si el navegador recibe un error despues de enviar el alta final, soporte debe
buscar primero el credito por folio o borrador antes de reintentar. El credito y
el consumo de la evaluacion se confirman en una sola transaccion, pero los
enlaces posteriores con FirmaSeguro y Veriff pertenecen al flujo existente y
pueden requerir conciliacion operativa; nunca debe ejecutarse otra consulta
pagada sin verificar si el credito ya fue creado.

## Activación segura

1. Desplegar el código con `DATACREDITO_QUERY_ENABLED=false`. Mantener la
   bandera apagada durante todo el preflight.
2. Ejecutar `npm run db:setup-datacredito` contra la base del ambiente. El SQL
   es idempotente y debe finalizar antes de activar la bandera; la preparación
   automática existe solo fuera de producción y no sustituye este preflight.
   Debe ejecutarlo la identidad de despliegue/migración; la aplicación en
   producción no necesita permisos `CREATE`, `ALTER` ni `CREATE INDEX`.
3. Crear el keyring en el gestor de secretos, cargar
   `DATACREDITO_RECORD_ENCRYPTION_KEYS_JSON` y seleccionar una clave mediante
   `DATACREDITO_RECORD_ENCRYPTION_ACTIVE_KEY_ID`. Verificar que la clave activa
   exista, decodifique a 32 bytes y que las claves anteriores necesarias sigan
   presentes. Sin un keyring válido la consulta debe permanecer deshabilitada.
4. Configurar `DATACREDITO_RETENTION_TOKEN` y un servicio cron diario de
   Railway usando `railway.datacredito-retention.json` como Config File Path.
   El cron ejecuta `npm run cron:datacredito-retention` a las 06:30 UTC, usa
   HTTPS, tiene timeout, termina al finalizar y elimina evaluaciones, expedientes
   cifrados y auditorías cuya retención ya venció.
5. Configurar y revisar las bandas desde Parámetros de crédito. Si existe una
   versión anterior sin regla `-1..-1` por plataforma o sin
   `maxFinancedAmount`, o una revisión sin
   `priorityRules.telcoDelinquency`, publicar primero una versión compatible
   mediante una operación controlada. Toda revisión nueva debe guardar
   `rejectAboveCopByPlatform.ANDROID` y
   `rejectAboveCopByPlatform.IPHONE`.
6. Cargar las credenciales y hosts de certificación, nunca en el repositorio, y
   fijar `DATACREDITO_ENVIRONMENT=uat` (o la etiqueta no productiva acordada).
   Confirmar que el guard impide ventas reales. Usar
   `DATACREDITO_ALLOW_NON_PRODUCTION_PROVIDER=true` solo durante una prueba
   controlada que requiera un build productivo y retirarlo al terminar.
7. Configurar y probar `VERIFF_BASE_URL`, `VERIFF_API_KEY` y
   `VERIFF_SHARED_SECRET`, junto con el modo compatible del flujo. Un caso
   aprobado debe abrir y completar Veriff antes de habilitar consultas para
   asesores.
8. Validar casos oficiales de aprobado, rechazado, sin información y error, y
   comprobar que el módulo central muestra el expediente y registra su acceso.
9. Confirmar que la ruta, módulos, límites y cobro de consultas coinciden con el
   contrato de Experian.
10. Obtener validación legal escrita del texto, evidencia, finalidad y retención
    del consentimiento. Sin esa aprobación, producción debe permanecer con
    `DATACREDITO_QUERY_ENABLED=false`.
11. Activar la bandera primero en certificación. Los resultados DEMO/UAT solo
    validan conectividad y reglas; no originan ventas reales.
12. Repetir todo el preflight con keyring, credenciales y hosts de producción
    separados. Confirmar `DATACREDITO_ENVIRONMENT=production`, ausencia del
    override no productivo y acceso central antes de activar la bandera.
## Confirmaciones pendientes de Experian

- host canonico de certificacion y host productivo;
- ruta canonica de MiDecisor para el producto contratado;
- ubicacion definitiva de credenciales de cliente en la solicitud de token;
- modulos habilitados, escala contractual y tratamiento de puntaje ausente;
- sujetos de prueba con respuestas deterministas;
- limite de peticiones, SLA, timeouts y efecto/costo de repetir una consulta;
- requisitos de IP allowlist, VPN, certificados o mTLS;
- evidencia de autorizacion exigida y periodo de conservacion;
- unidad contractual especifica de `montoSugerido` e `ingreso`;
- confirmacion de que el reporte de obligaciones requiere otro producto/API.

La clave recibida por correo abre el archivo de manuales. No es una credencial
de API y no debe configurarse en Railway.
