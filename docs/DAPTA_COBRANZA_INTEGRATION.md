# Registro de cobranza de Dapta en FINSERPAY

Estado: implementación local; pendiente de publicación y configuración de Dapta.

La consulta de Diana y la cartera de mora son contratos distintos. Esta integración
reutiliza `getMoraManagement` y `moraCreditSummary`, la misma fuente que
`/dashboard/aprobaciones/cartera-mora`. No consulta ni escribe Google Sheets.

## Configuración privada

- `FINSERPAY_COBRANZA_API_TOKEN`: secreto propio de esta integración, mínimo 32 caracteres.
- `FINSERPAY_COBRANZA_AGENT_ID`: UUID del nuevo agente de voz; no el de Diana.
- `FINSERPAY_COBRANZA_ACTOR_ID=51`: usuario **Agente IA**, confirmado en el selector
  de responsables de producción el 9 de octubre de 2026. La transacción revalida
  su cuenta, rol y pertenencia activa a FINSERPAY antes de guardar cada gestión.

El token se conserva en configuración privada del servidor y en el almacén de
secretos de Dapta, nunca en el prompt, parámetros solicitados al cliente ni Git.
Las rutas fallan cerradas si falta configuración. No reutilizar el token de Diana.

## Consulta interna

`POST /api/integraciones/cobranza/creditos`, con `Authorization: Bearer <secreto>`
y `Content-Type: application/json`. Cuerpo: `{"creditoId":123}`.

Devuelve valor vencido, días de mora, último pago, última gestión y señal para
suspender cobranza cuando no hay mora, existe acuerdo en la última gestión o
se informó un pago pendiente de validación. Esa señal es interna: no demuestra
titularidad y no sustituye las comprobaciones de canales, horarios y frecuencia.
La verificación de identidad del cliente debe estar conectada antes de revelar
información financiera en voz. No suministrar el ID por suposición del modelo.

La cartera no acredita etapas jurídicas. Bloqueo aplicable, reporte habilitado,
reporte confirmado, traslado prejurídico y evaluación judicial se devuelven como
`null`. Hasta incorporar una fuente autorizada, el agente omite esas advertencias.

## Registro interno

`POST /api/integraciones/cobranza/gestiones`, con los mismos encabezados.

```json
{
  "creditoId": 123,
  "agentId": "UUID_REAL_DEL_NUEVO_AGENTE",
  "callId": "IDENTIFICADOR_REAL_DE_LLAMADA",
  "actedAt": "2026-10-09T15:00:00Z",
  "result": "ACUERDO_PAGO",
  "comment": "Cliente confirmó fecha y valor del acuerdo durante la llamada.",
  "nextFollowUpAt": "2026-10-10T15:00:00Z",
  "agreementDate": "2026-10-10",
  "agreementAmount": 50000,
  "agreementConfirmed": true
}
```

Ejemplo sintético de contrato, nunca usar como una gestión real. El Flow debe
obtener el crédito, agente e identificador de llamada de la vinculación real del
evento. El modelo no elige responsable, estado ni clave de idempotencia.

Resultados admitidos: `SIN_RESPUESTA`, `MEDIOS_PAGO`, `PAGO_REALIZADO` y
`ACUERDO_PAGO`. No transformar una llamada sin acuerdo en MEDIOS_PAGO si no
se compartieron medios. Otros resultados requieren revisión y extensión explícita
del catálogo; no se sustituyen por una clasificación falsa.

La ruta exige confirmación explícita de términos para un acuerdo, y el Flow debe
conservar la evidencia real; una extracción automática no acredita por sí sola esa
confirmación. No permite conceder descuentos, prórrogas ni modificar el crédito.
Un pago informado se registra en SEGUIMIENTO y no como pago validado o solucionado.

`createMoraManagement` guarda en `CreditMoraManagementEvent`, visible en el
historial de cartera, con fecha, valor y responsable. Su transacción valida rol,
fechas, monto y mora actual. La clave se deriva de agente y llamada: reintentos
idénticos no duplican; contenido diferente para la misma llamada entra en conflicto.
La ruta devuelve `registrado:true` solo tras obtener el registro persistido.

## Sustitución de Google Sheets y comprobación

1. Publicar estas rutas y configurar secreto, nuevo agente y responsable.
2. Preparar en Dapta el cambio de `postcall_cobranzas`: eliminar Buscar Lead,
   Contar Llamadas y Guardar en Google Sheets; reemplazar por registro autenticado.
   No conservar Google Sheets como fallback. No borrar datos históricos.
3. Mostrar la previsualización y obtener la confirmación exigida por el MCP antes
   del commit. No desconectar el destino vigente antes de tener listo el nuevo.
4. Probar un caso sintético controlado, verificar la respuesta persistida y leer
   el registro desde el historial FINSERPAY. No usar créditos reales como fixtures.
5. Conectar al nuevo agente separado de Diana y comprobar su webhook de análisis.

Pendientes: aprobación de plantillas `medios`/`soporte`, enrutamiento de texto
separado de Diana, controles globales de contactabilidad, automatización de
seguimiento y prueba de despedida por ticket #143326236. Esta implementación
no enciende marcación, no envía WhatsApp y no acredita que Dapta ya esté conectado.

Pruebas: `node --test tests/dapta-collections-http.test.mjs` y
`node --experimental-strip-types --test tests/analyst-mora.test.mjs`.
