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
    "cuotasEnMora": 2,
    "orientacion": "Tienes cuotas vencidas. Consulta el portal para revisar y pagar el saldo vencido. Si ya pagaste y el abono no aparece, solicita revision del comprobante con soporte."
  }]
}
```

Se devuelven todos los creditos no anulados, del mas reciente al mas antiguo. Se excluyen abonos anulados. El saldo y la mora usan buildCreditPaymentPlan, igual que el portal, con la fecha de Colombia. Los creditos con paz y salvo se consideran pagados.

Estado general: MORA si hay algun credito en mora; AL_DIA si hay saldo pendiente sin mora; PAGADO si todos estan pagados. SIN_CREDITOS devuelve encontrado=false y creditos=[] con HTTP 200.

valorAPagar es el total vencido en mora, el saldo de la proxima cuota si esta al dia, o cero si esta pagado. No es una liquidacion anticipada ni incluye cargos distintos a los calculados por el plan existente. fechaVencimiento es la primera cuota pendiente (puede estar vencida); es null al pagar todo. Los importes son numeros en COP.

La respuesta evita nombre, cedula, telefono, direccion y documentos del cliente. Todas las respuestas usan Cache-Control: private, no-store.

## Manejo por Diana

Consultar antes de responder sobre estado de credito. Identificar cada credito por folio cuando haya varios. Utilizar los importes y fechas de la respuesta, sin inventar descuentos ni prometer cancelaciones. Si el cliente afirma haber pagado y el abono no aparece, solicitar revision con soporte. Ante SIN_CREDITOS, comprobar la cedula sin afirmar que no existe el cliente. Ante errores, informar que la consulta no esta disponible y dirigir al portal o soporte.

## Errores y validacion

400: cedula o JSON invalidos. 401: token ausente o incorrecto. 415: contenido distinto de JSON. 503: integracion sin configurar. 500: fallo de consulta. Next.js devuelve 405 para metodos no implementados.

Pruebas: node --test tests/diana-credit-api.test.mjs

La implementacion local no configura secretos, despliega ni conecta automaticamente Dapti. Tras desplegar, comprobar una consulta autorizada y otra sin token antes de activar la automatizacion.
