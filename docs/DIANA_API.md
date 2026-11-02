# Integracion Diana / Dapti

Endpoint: POST /api/integraciones/diana/creditos
URL prevista tras despliegue: https://finserpay.com/api/integraciones/diana/creditos

## Configuracion

Configurar FINSERPAY_DIANA_API_TOKEN en el servidor con un secreto aleatorio exclusivo (al menos 32 bytes). Generar con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` en un entorno seguro. Guardarlo en las credenciales de la automatizacion de Dapti; no incluirlo en instrucciones del agente, repositorio ni variables NEXT_PUBLIC_. Si falta, la API devuelve 503. No acepta cookies ni tokens de otras integraciones.

En Flow Studio configurar una solicitud HTTP POST con:

- Authorization: Bearer <token configurado>
- Content-Type: application/json
- Cuerpo JSON: {"cedula":"123456789"}, sustituyendo la cedula por la variable del cliente.

La cedula debe ser texto de 5 a 15 digitos, conservando ceros iniciales. Se consulta por coincidencia exacta. No se envian documentos en la URL. Esta integracion se realiza desde el servidor de Dapti.

## Respuesta

Ejemplo ilustrativo, sin datos reales:

```json
{
  "ok": true,
  "encontrado": true,
  "estado": "MORA",
  "moneda": "COP",
  "consultadoAt": "2026-10-06T15:00:00.000Z",
  "portalClientes": "https://finserpay.com/clientes",
  "creditos": [{
    "folio": "EJEMPLO-1",
    "estado": "MORA",
    "saldoPendiente": 250000,
    "saldoVencido": 150000,
    "valorAPagar": 150000,
    "fechaVencimiento": "2026-09-10",
    "cuotasPagadas": 0,
    "cuotasPendientes": 3,
    "cuotasTotales": 3,
    "totalCuotasPendientes": 250000,
    "cuotasEnMora": 2,
    "liquidacionAnticipada": {
      "disponible": false,
      "capitalPendiente": null,
      "motivo": "La liquidacion anticipada solo aplica cuando el credito esta al dia.",
      "consultadoAt": "2026-10-06T15:00:00.000Z",
      "proximaCuotaFecha": "2026-09-10"
    },
    "prorroga": {
      "verificada": true,
      "disponible": false,
      "motivo": "La prórroga admite de 1 a 4 días desde el vencimiento 02/17, hasta el día 06/21.",
      "cuotaNumero": 1,
      "vencimientoCuota": "2026-09-10",
      "opciones": [],
      "compromisoSugerido": { "valor": null, "fecha": null },
      "consultadoAt": "2026-10-06T15:00:00.000Z"
    },
    "orientacion": "Tienes cuotas vencidas. Consulta el portal para revisar y pagar el saldo vencido. Si ya pagaste y el abono no aparece, solicita revision del comprobante con soporte."
  }]
}
```

Se devuelven todos los creditos no anulados, del mas reciente al mas antiguo. Se excluyen abonos anulados. El saldo y la mora usan buildCreditPaymentPlan, igual que el portal, con la fecha de Colombia. Los creditos con paz y salvo se consideran pagados.

Estado general: MORA si hay algun credito en mora; AL_DIA si hay saldo pendiente sin mora; PAGADO si todos estan pagados. SIN_CREDITOS devuelve encontrado=false y creditos=[] con HTTP 200.

valorAPagar es el total vencido en mora, el saldo de la proxima cuota si esta al dia, o cero si esta pagado. No es una liquidacion anticipada ni incluye cargos distintos a los calculados por el plan existente. fechaVencimiento es la primera cuota pendiente (puede estar vencida); es null al pagar todo. Los importes son numeros en COP.

`cuotasTotales` cuenta las cuotas no eliminadas del plan vigente, incluyendo las
pagadas. Si hubo un abono a capital que elimino cuotas, no se presenta el plazo
original como si todas siguieran vigentes. `totalCuotasPendientes` es la suma real
de los saldos pendientes del plan (`saldoPendiente`); no se multiplica la cantidad
de cuotas por el valor habitual, pues puede haber cuotas parcialmente pagadas o
un ultimo importe distinto.

`liquidacionAnticipada` reutiliza `calculateCreditEarlyPayoff`, la misma funcion
del portal de clientes, con capital financiado, intereses, fianza, componentes
contractuales, plan de capital vigente y abonos registrados. `disponible` conserva
la regla actual: credito al dia, sin paz y salvo y con capital pendiente. Si no
aplica, `capitalPendiente` es `null` y `motivo` explica por que; no se ofrece un
importe de liquidacion para un credito en mora o pagado.

El capital corresponde a la consulta de **hoy**, cuya fecha exacta figura en
`consultadoAt`. La elegibilidad utiliza el calendario de Colombia, igual que el
plan de pagos. El dia de vencimiento sigue siendo un dia al corriente conforme a
la regla existente; esta ampliacion no adelanta ni retrasa el inicio de mora.
`proximaCuotaFecha` conserva la fecha de la primera cuota pendiente, o `null`
si esta pagado. Es contexto del plan, **no** una fecha garantizada de vigencia de
la cotizacion: el importe debe recalcularse antes de pagar y puede cambiar con
nuevos abonos, ajustes o revisiones del plan. Este endpoint no crea una intencion
de pago ni registra una liquidacion.

La respuesta evita nombre, cedula, telefono, direccion y documentos del cliente. Todas las respuestas usan Cache-Control: private, no-store.

## Opciones de prorroga: consulta, no concesion

Cada credito incluye `prorroga`, calculada con `extensionEligibility`, la misma
politica de Atencion. Se revisa la primera cuota regular pendiente del plan
vigente, incluso antes del vencimiento, y se ofrecen exclusivamente 1, 2, 3 o 4
dias desde el vencimiento regular 02/17, hasta el dia 06/21. Las fechas que ya
pasaron se excluyen utilizando el calendario de Colombia. No son dias contados
desde hoy ni existe una nueva restriccion mensual en esta consulta.

Se consultan en una sola lectura las solicitudes `PENDING` y `APPROVED` de
`CreditMoraExceptionRequest`, igual que en la ficha financiera de Atencion.
Una solicitud pendiente o una proteccion aprobada vigente, incluso sin fecha de
caducidad, impide ofrecer otra prorroga. Una aprobada cuya fecha ya paso no es
proteccion vigente. Esta lectura no expira ni modifica los registros.

`verificada=true` significa que la consulta de protecciones fue acreditada y la
politica pudo evaluarse; no significa que el cliente este identificado por su
chat ni que la prorroga este aprobada. `disponible=true` indica opciones
consultables en ese instante. `cuotaNumero` y `vencimientoCuota` identifican la
cuota regular evaluada; son `null` si no existe. `opciones` contiene objetos
`{dias,fechaLimite}` y `compromisoSugerido` contiene `{valor,fecha}` solo cuando
hay opciones disponibles; sus dos valores son `null` cuando no las hay. Es una
sugerencia del CRM, no un acuerdo aceptado por el cliente.

El plan para prorroga usa unicamente abonos `ACTIVO`, no anulados y de valor
positivo, igual que el CRM; conserva el vencimiento regular sin la sustitucion
administrativa de `fechaProximoPago`. Los campos previos de saldo y capital
mantienen su calculo actual. Si estos informan `PAGADO`, se bloquean las opciones
y se devuelven cuota y vencimiento nulos, tambien para registros historicos
`PAZ_Y_SALVO` sin fecha o sin libro de abonos completo. No se fabrica una fecha de
paz y salvo ni se modifica la politica compartida.

Si faltan la tabla o las columnas de protecciones, falla su lectura o los datos
son incoherentes, se conserva la respuesta financiera ordinaria pero se devuelve
`verificada=false`, `disponible=false`, `opciones=[]` y un motivo para derivar al
analista. Nunca se interpreta un fallo de lectura como ausencia de proteccion.
No se exponen identificadores internos de credito o excepcion, actores ni
metadatos privados.

Este campo **no concede prorrogas**. La consulta y su autenticacion conservan
el cuerpo `{cedula}`. Diana no debe anunciar una prorroga aprobada por recibir
opciones. El otorgamiento usa el flujo independiente descrito a continuacion.

## Prórroga por solicitud directa del cliente

La petición clara del cliente es la autorización para una prórroga de 1 a 4
días permitida por el CRM. Diana no debe pedir código, importe, motivo,
compromiso ni una segunda confirmación. Solo pregunta cuando falta precisar
los días o identificar el crédito entre varios. Las fechas se calculan desde
el vencimiento regular, con los límites 06/21 existentes; no se amplía esa
política financiera ni se supone que una consulta de opciones sea una petición.

La concesión la procesa el trabajador de eventos nativos. Antes de escribir,
relee el historial completo y actual mediante MCP, verifica mensaje entrante,
autor, teléfono registrado, conversación, canal y línea, y descarta
cancelaciones, consultas hipotéticas, ambigüedades y orden temporal incierto.
Una cédula, un folio o un indicador del modelo no autorizan la operación. Si
varias identidades comparten el teléfono, se deriva al analista. Si hay varios
créditos activos de la misma persona, se requiere una elección expresa del
cliente; una vinculación manual de la conversación no sustituye esa elección.

La validación reutiliza el plan de pagos real, los pagos activos y la misma
elegibilidad de Atención. Bloquea nuevamente los registros antes de guardar.
El UUID nativo se consume una sola vez en `DianaExtensionRequest`; la petición
caduca a los 15 minutos y debe ser posterior a la activación. La concesión,
el evento financiero y el seguimiento de cartera se guardan en una transacción.
La fuente es `SYSTEM_DIANA_REQUEST`, con actor sistema Diana, responsable y
fecha. Los importes y fechas de compromiso quedan nulos: no se inventa un
acuerdo de pago. El seguimiento queda a las 08:00 de Colombia del día siguiente
a la fecha límite. La sincronización del equipo ocurre después del commit.

La acción `gestionar_prorroga_finserpay` conserva su nombre y el flujo `QBwOS`,
pero en este modo solo recibe `cedula` y `folio`, ambos texto. El flujo envía:

```json
{"accion":"consultar_solicitud","cedula":"001234567","folio":"EJEMPLO-1"}
```

`POST /api/integraciones/diana/prorrogas` conserva el Bearer dedicado existente.
Esta operación únicamente consulta y espera brevemente el resultado del
trabajador. No acepta días, códigos, mensajes, teléfonos ni autorización del
modelo. Devuelve `ok`, `estado`, `aprobada`, `yaExistia`, `dias`, `cuotaNumero`,
`vencimientoCuota`, `fechaLimite` y `motivo`. Solo `aprobada=true` con una
protección vigente permite confirmar la fecha al cliente. Un estado `PENDING`
no es aprobación. `yaExistia=true` identifica una protección vigente anterior;
no se anuncia como una nueva concesión. Todas las respuestas son privadas y
sin caché.

### Despliegue del modo directo

El modo queda desactivado por defecto. `scripts/railway-predeploy.mjs` prepara
el libro de solicitudes y verifica columnas, claves, restricciones y auditoría.
Si falla, el despliegue no continúa. No se ejecuta DDL desde HTTP.
`node scripts/ensure-diana-extension-request-schema.mjs --check` solo lee el
esquema; `--apply` ejecuta la preparación transaccional idempotente.

Después de publicar el backend y verificar el esquema, se actualizan los
cuatro campos documentados de `QBwOS`, el filtro nativo `MdjEt` para mensajes
entrantes y las instrucciones/acción de Diana. Se conservan autorización HTTP,
consulta de crédito, transferencia humana, número, proveedor y otros ajustes.
Los borradores revisables están en `docs/integrations/diana-extension-requests/`.
Finalmente se configura `DIANA_REQUEST_EXTENSIONS_ENABLED=true` junto con
`DIANA_REQUEST_EXTENSIONS_ACTIVATED_AT` en UTC. Esta fecha impide conceder por
mensajes anteriores a la activación. La bandera antigua es independiente y se
conserva por compatibilidad; no activa el nuevo modo.

Las pruebas locales usan datos sintéticos y PostgreSQL embebido. No envían
WhatsApp ni conceden prórrogas reales. La publicación externa y la comprobación
de una concesión real deben distinguirse de esos resultados.

## Propuesta y confirmacion de una prorroga (compatibilidad anterior)

Este contrato se conserva para propuestas históricas. La acción de Diana del
modo directo utiliza `consultar_solicitud`, descrita arriba, y no pide códigos.

`POST /api/integraciones/diana/prorrogas` utiliza un Bearer dedicado
`FINSERPAY_DIANA_EXTENSION_API_TOKEN`, distinto del token de consulta, y requiere
`DIANA_EXTENSIONS_ENABLED=true`. La integracion de eventos, la linea configurada
y las credenciales de lectura MCP tambien deben estar listas. Por defecto esta
capacidad queda desactivada. El endpoint no acepta actores, IDs de mensajes o
conversaciones ni un campo `confirmed` proporcionado por el modelo.

Dos operaciones JSON estan admitidas:

- `accion: "proponer"`: `cedula`, `folio`, `dias` (numero 1, 2, 3 o 4),
  `valorCompromiso`, `fechaCompromiso` (`YYYY-MM-DD`) y `motivo`.
- `accion: "consultar"`: `codigo` de la propuesta. Espera hasta 15 segundos por
  el procesamiento del evento real, sin ejecutar ninguna aprobacion.

La respuesta publica contiene `codigo`, `estado`, `aprobada`, `oferta`,
`propuestaVenceAt`, `dias`, `cuotaNumero`, `vencimientoCuota`, `fechaLimite` y
`compromiso: {valor,fecha}`. Excluye nombres, documentos, telefonos, IDs internos
y actores. Solo `aprobada=true` acredita una concesion registrada y todavia
vigente en la fuente financiera canonica; una propuesta o un estado historico
`GRANTED` por si solos no prueban que la proteccion siga activa.

La propuesta se guarda con terminos inmutables y vence a los 15 minutos. Solo se
admite una pendiente por credito. El credito debe estar vinculado a un telefono
real y sin conflicto de identidad; una cedula escrita al bot o guardada en
localStorage no constituye autenticacion del cliente. La propuesta devuelve el
texto canonico `oferta`, que Diana debe transmitir completo y sin reformular.
Incluye el folio, cuota, fechas, importe, caducidad y la instruccion de contestar
`CONFIRMO PR-` seguida de un codigo criptografico de 16 caracteres hexadecimales.

El flujo nativo de Dapta solo despierta una tarea durable con identificadores.
El trabajador relee la conversacion real mediante MCP `fresh`; exige el UUID,
direccion, autor, estado de entrega, fecha y contacto exactos, ademas del
workspace, agente y canal nativos configurados. La oferta saliente debe ser
exactamente el texto persistido y haber llegado al telefono registrado del
deudor. La comprobacion usa un hash privado del contenido original verificado,
calculado antes de redactar numeros sensibles para la importacion del CRM. El
codigo y el hash no contienen el cuerpo original; el filtro visible no se
debilita. Esto admite tambien folios con numeros largos y codigos totalmente
numericos sin usar el texto visible como prueba financiera.
A partir de esa prueba se vincula al chat. Solo una confirmacion entrante
posterior, del mismo telefono/chat/linea, con el codigo exacto, permite conceder.
Un evento pendiente, texto atribuido por el modelo o una oferta para otro
contacto no tienen autoridad financiera. Un perfil BSUID sin telefono verificado
se deriva al analista.

Antes del commit se bloquean los registros, se vuelve a verificar identidad,
cuota, plazo, calendario de Colombia, pagos activos, importe y fecha del
compromiso, y protecciones vigentes, reutilizando `extensionEligibility` y
`evaluateMoraExceptionRule`. Si algo cambio, hay que consultar y confirmar una
nueva propuesta. La concesion, el evento financiero, la gestion `ACUERDO_PAGO`,
la auditoria y el cierre de la propuesta se registran en una sola transaccion;
los reintentos no conceden otra prorroga. El responsable es `SYSTEM_DIANA`/Diana,
con campos de actor sistema propios, sin crear un usuario administrador ficticio
ni atribuir el acto a un analista. Las revisiones humanas posteriores conservan
esa autoria original y dejan su propio evento.

El seguimiento queda para las 08:00 de Colombia del dia siguiente al compromiso.
La sincronizacion de mora del equipo se realiza despues del commit; un fallo
del proveedor no revierte la prorroga ni su historial.

### Preparacion y activacion

1. Publicar el codigo con `DIANA_EXTENSIONS_ENABLED=false`; actualizar todos los
   runtimes que utilicen los instaladores compartidos de cartera.
2. Ejecutar `node scripts/ensure-atencion-schema.mjs` segun su contrato y
   `node scripts/ensure-diana-extension-schema.mjs --apply`. El segundo instalador
   prepara la tabla de propuestas y la autoria sistema en cartera, en una
   transaccion idempotente. No se ejecuta DDL durante una solicitud de propuesta.
3. Comprobar `node scripts/ensure-diana-extension-schema.mjs --check` (solo lectura).
   La salida contiene unicamente estado y conteos de preparacion, sin datos de
   clientes. No activar mientras algun control no este listo.
4. Configurar en Dapta la accion de propuesta/consulta con el Bearer dedicado y
   ampliar el filtro de eventos a confirmaciones entrantes `CONFIRMO PR-...`.
   Conservar las acciones, webhooks, numero y proveedor existentes.
5. Publicar las instrucciones que obligan a reproducir la oferta canonica y
   consultar el estado despues de confirmar. Activar la variable solamente
   cuando esquema, accion, eventos y despliegue esten verificados.

Pruebas locales: `npm run test:diana`. Utilizan fixtures y PostgreSQL embebido;
no envian WhatsApp, no consultan clientes reales ni conceden prorrogas reales.

### Configuracion verificada en produccion

El 2 de noviembre de 2026 se publico la accion `gestionar_prorroga_finserpay`
en Diana, conectada al flujo `QBwOS` (FINSERPAY — Prorrogas de Diana). Conserva
la consulta de credito y la transferencia humana. El flujo `MdjEt` mantiene
sus seis nodos y admite las confirmaciones entrantes exactas, ademas de los
mensajes salientes existentes. El Bearer dedicado se configuro desde el entorno
de Railway directamente hacia Dapta, sin archivos de credenciales.

`DIANA_EXTENSIONS_ENABLED=true` quedo desplegado y se verifico una consulta
autenticada de un codigo inexistente: 404 «Propuesta no encontrada». Esta prueba
comprueba habilitacion, alcance, esquema y conexion a BD sin crear propuestas ni
concesiones. No sustituye una prueba real autorizada de oferta y confirmacion.
Los mensajes anteriores a esta activacion no conceden prorrogas retroactivas.

## Manejo por Diana

Consultar antes de responder sobre estado de credito. Identificar cada credito por folio cuando haya varios. Utilizar los importes y fechas de la respuesta, sin inventar descuentos ni prometer cancelaciones. Si el cliente afirma haber pagado y el abono no aparece, solicitar revision con soporte. Ante SIN_CREDITOS, comprobar la cedula sin afirmar que no existe el cliente. Ante errores, informar que la consulta no esta disponible y dirigir al portal o soporte.

Cuando pregunten por el pago total, distinguir la cantidad de cuotas pendientes,
su total monetario y el capital para liquidar hoy. Solo presentar este ultimo
si `liquidacionAnticipada.disponible=true`, usando exactamente el importe
devuelto. Informar la fecha de la siguiente cuota como contexto y volver a
consultar antes de orientar un pago; no asegurar que el mismo capital estara
disponible hasta esa fecha. Si la liquidacion no aplica, utilizar `motivo` y
mantener los saldos ordinarios separados.

Esta ampliacion conserva el cuerpo `{cedula}` y su autenticacion. No reconoce
automaticamente a una persona por su chat, no cambia las instrucciones publicadas
de Diana y no habilita el envio de recibos; esas capacidades requieren su propio
contexto autenticado, autorizacion y configuracion del agente.

## Errores y validacion

400: cedula o JSON invalidos. 401: token ausente o incorrecto. 415: contenido distinto de JSON. 503: integracion sin configurar. 500: fallo de consulta. Next.js devuelve 405 para metodos no implementados.

Pruebas: node --test tests/diana-credit-api.test.mjs

La implementacion local no configura secretos ni conecta automaticamente Dapta.
Tras desplegar, comprobar el esquema y las respuestas sin token/con la capacidad
desactivada antes de activar. Una prueba con un credito real cambia cartera: no
crear una propuesta ni enviar su confirmacion como prueba sin autorizacion.
