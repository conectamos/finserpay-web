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
4. El servidor consulta MiDecisor y extrae unicamente el puntaje validado.
5. El servidor resuelve la banda vigente para la plataforma.
6. Si la banda rechaza, el flujo termina con `NO APROBADO`.
7. Si la banda aprueba, se fija la cuota inicial y la fianza de esa banda y se
   abre la validacion de identidad existente.
8. Al crear el credito, el servidor vuelve a validar y consume la evaluacion;
   el navegador nunca decide ni puede modificar la banda aplicada.

Una falla tecnica, una respuesta parcial o la ausencia de puntaje se presenta
como `No se pudo evaluar`; nunca se convierte en rechazo.

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

## Variables de entorno

Todas son variables exclusivas del servidor. Ninguna debe usar el prefijo
`NEXT_PUBLIC_` ni guardarse en Git, imagenes, logs o archivos del repositorio.

| Variable | Uso |
| --- | --- |
| `DATACREDITO_QUERY_ENABLED` | Activa el requisito de precalificacion. Por defecto debe ser `false`. |
| `DATACREDITO_ENVIRONMENT` | Etiqueta operativa, por ejemplo `uat` o `production`. |
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
| `DATACREDITO_ASSESSMENT_TTL_MINUTES` | Vigencia de una evaluacion no consumida; predeterminado 120 minutos. |
| `DATACREDITO_RETENTION_DAYS` | Retencion de auditoria minimizada. |
| `DATACREDITO_RETENTION_TOKEN` | Token aleatorio de al menos 32 bytes para el cron de eliminacion por retencion. Puede usarse `CRON_SECRET` como respaldo. |
| `DATACREDITO_RATE_LIMIT_MAX` | Maximo de intentos en 15 minutos por usuario o cedula seudonimizada dentro de la sede. |

`DATACREDITO_AUDIT_HMAC_SECRET` no debe reutilizar la clave de sesion ni otra
credencial. Debe tener al menos 32 bytes aleatorios y rotarse mediante un plan
que contemple los hashes historicos.

## Politica dinamica

Cada version contiene bandas separadas para `ANDROID` e `IPHONE`:

```json
{
  "id": "identificador-estable",
  "platform": "ANDROID",
  "scoreMin": 0,
  "scoreMax": 950,
  "decision": "APROBADO",
  "initialPaymentPercentage": 20,
  "suretyPercentage": 60
}
```

La administracion exige cobertura completa de 0 a 950 para cada plataforma,
sin huecos ni solapes. Guardar genera una version nueva. No existe una politica
predeterminada: los umbrales, la decision, la inicial y la fianza son una
definicion comercial de FINSER PAY.

## Proteccion y auditoria

- No se guarda la respuesta completa de Experian.
- No se guardan cedula ni apellido en claro dentro de la evaluacion.
- Se conserva solo hash HMAC, ultimos cuatro digitos, decision, oferta,
  version de politica y metadatos tecnicos minimizados.
- IP y agente de usuario se conservan como HMAC, no en claro.
- El asesor no recibe el puntaje ni los umbrales.
- Los errores publicos incluyen un identificador de correlacion, no detalles de
  credenciales ni del proveedor.
- Una evaluacion se vincula a usuario, asesor, aliado y sede; no puede usarse en
  otro contexto ni con otro documento, apellido o plataforma.
- Las llamadas tienen timeout y limite de bytes. Solo un `401` permite renovar
  el token y repetir una vez; no se reintentan consultas ambiguas.
- En produccion la aplicacion no crea ni altera tablas o indices. Solo verifica
  mediante catalogos PostgreSQL que el preflight fue aplicado y responde `503`
  si el esquema no esta listo.

Si el navegador recibe un error despues de enviar el alta final, soporte debe
buscar primero el credito por folio o borrador antes de reintentar. El credito y
el consumo de la evaluacion se confirman en una sola transaccion, pero los
enlaces posteriores con FirmaSeguro y Veriff pertenecen al flujo existente y
pueden requerir conciliacion operativa; nunca debe ejecutarse otra consulta
pagada sin verificar si el credito ya fue creado.

## Activacion segura

1. Desplegar el codigo con `DATACREDITO_QUERY_ENABLED=false`.
2. Ejecutar `npm run db:setup-datacredito` contra la base del ambiente. El SQL
   es idempotente y debe finalizar antes de activar la bandera; la preparacion
   automatica existe solo fuera de produccion y no sustituye este preflight.
   Debe ejecutarlo la identidad de despliegue/migracion; la aplicacion en
   produccion no necesita permisos `CREATE`, `ALTER` ni `CREATE INDEX`.
3. Configurar `DATACREDITO_RETENTION_TOKEN` y un cron diario de Railway con el
   comando `npm run cron:datacredito-retention`. El cron usa HTTPS, tiene timeout
   y elimina las evaluaciones cuyo `retainedUntil` ya vencio.
4. Configurar y revisar las bandas desde Parametros de credito.
5. Cargar en Railway las credenciales y hosts de certificacion, nunca en el
   repositorio.
6. Configurar y probar `VERIFF_BASE_URL`, `VERIFF_API_KEY` y
   `VERIFF_SHARED_SECRET`, junto con el modo de operacion compatible del flujo.
   Un caso aprobado debe abrir y completar Veriff antes de habilitar consultas
   pagas para asesores.
7. Validar casos oficiales de aprobado, rechazado, sin informacion y error.
8. Confirmar que la ruta, modulos, limites y cobro de consultas coinciden con el
   contrato de Experian.
9. Obtener validacion legal escrita del texto, evidencia, finalidad y retencion
   del consentimiento. Sin esa aprobacion, produccion debe permanecer con
   `DATACREDITO_QUERY_ENABLED=false`.
10. Activar la bandera primero en certificacion.
11. Repetir el proceso con credenciales y hosts de produccion separados.

## Confirmaciones pendientes de Experian

- host canonico de certificacion y host productivo;
- ruta canonica de MiDecisor para el producto contratado;
- ubicacion definitiva de credenciales de cliente en la solicitud de token;
- modulos habilitados, escala contractual y tratamiento de puntaje ausente;
- sujetos de prueba con respuestas deterministas;
- limite de peticiones, SLA, timeouts y efecto/costo de repetir una consulta;
- requisitos de IP allowlist, VPN, certificados o mTLS;
- evidencia de autorizacion exigida y periodo de conservacion;
- moneda y unidad de montos informados por MiDecisor;
- confirmacion de que el reporte de obligaciones requiere otro producto/API.

La clave recibida por correo abre el archivo de manuales. No es una credencial
de API y no debe configurarse en Railway.
