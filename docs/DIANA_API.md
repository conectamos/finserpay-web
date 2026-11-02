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

La implementacion local no configura secretos, despliega ni conecta automaticamente Dapti. Tras desplegar, comprobar una consulta autorizada y otra sin token antes de activar la automatizacion.
