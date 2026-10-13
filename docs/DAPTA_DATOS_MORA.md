# Campaña Datos: aviso único al cumplir 20 días de mora

## Selección y horario

- Lee nombre, celular, plan y abonos directamente de Cartera. La mora corresponde a los días desde la cuota más antigua que aún tiene saldo pendiente, en calendario de Colombia.
- Selecciona únicamente mora **igual a 20 días**. No anticipa el aviso a los 19 días ni procesa créditos con 21 días o más. Excluye créditos anulados, pagados, con paz y salvo, sin saldo o sin un calendario financiero válido.
- Un crédito recibe como máximo **un intento de aviso Datos**, aunque después cambie de celular, vuelva a tener una cuota con 20 días de mora o cambie el crédito representante del grupo.
- Revisa diariamente a las **10:00 a. m. America/Bogota**, con recuperación durante 10:00–10:59. Si no se procesa un crédito en su día 20, no existe envío de recuperación en días posteriores.
- Usa solamente `clienteTelefono`, con celular colombiano validado; nunca números de referencia. Agrupa los créditos elegibles por celular normalizado y realiza como máximo un envío por celular y fecha Bogotá.
- Un envío cubre todos los créditos de ese grupo que continúan elegibles al reservar y revalidar. El crédito representante es el de menor ID entre los elegibles. Un crédito nuevo que alcance 20 días en otra fecha puede recibir su aviso en el mismo celular, sin esperar tres días.
- Antes de HTTP vuelve a consultar créditos, abonos y teléfono. Si un crédito ya no está exactamente en 20 días, quedó pagado o cambió de celular, no lo incluye en ese envío.

La campaña ya no es recurrente cada tres días. No exporta Excel, no procesa el acumulado de mora anterior y no repite avisos históricos. Un intento previo en cualquier estado, incluso antes de esta revisión, bloquea otro aviso para el crédito que identifica ese registro.

## Plantilla existente y flujo

Workspace: FINSERPAY (`7496b9a3-2fe6-4e28-8411-7d54ee788b2c`).

La campaña se llama **Datos**. La plantilla aprobada en Meta tiene el nombre técnico **`data`**, ID `292ba826-2bbc-43d2-abcc-c8e5d5253ca7`; contiene un aviso previo de reporte negativo. Se conserva su texto aprobado, que menciona 20 días desde el aviso: ese texto no debe confundirse con el filtro de 20 días de mora ni autoriza una operación de reporte a centrales. Esta integración únicamente envía la plantilla.

El flujo existente recibe POST con `credito_id`, `telefono`, `nombre` y `dias_mora`, normaliza el contacto, exige mora exactamente igual a 20, ejecuta el nodo nativo de plantilla y responde `ok:true`. El filtro exacto del flujo ya se guardó y verificó; la cobertura única por crédito corresponde a la revisión del backend, pendiente de publicación coordinada. Canal: agente Diana. Variable única: `contact_name`; el teléfono se pasa como string `+{{normalizar_contacto.telefono}}`. No se modifican la plantilla ni los atributos nativos del flujo.

La clave técnica histórica `datos_mora_20_cada_3_dias` se conserva por compatibilidad con el registro existente; su nombre no define la frecuencia actual.

## Configuración privada

Variables del servicio `finserpay-web` en Railway:

- `DAPTA_DATOS_ENABLED=true` activa la campaña; ausente o cualquier otro valor no envía.
- `DAPTA_DATOS_WEBHOOK_URL` contiene la URL privada del flujo, con su credencial integrada.
- `DAPTA_DATOS_START_DATE=YYYY-MM-DD` es opcional e impide envíos antes de la primera fecha acordada. Una fecha imposible bloquea la configuración. No habilita avisos atrasados para créditos que ya superaron 20 días.
- `DAPTA_DATOS_INITIAL_BATCH_DATE` es un dato legado informativo. Ya no habilita envíos fuera de 10:00–10:59 ni altera la elegibilidad o la deduplicación. Un valor inválido de esa variable antigua no desconfigura esta campaña.

No guardar URL privada ni credenciales en Git, documentación o logs. Sólo se aceptan URL HTTPS de `api.dapta.ai`, sin userinfo/puerto, y no se siguen redirecciones. El cambio no modifica horarios, variables ni registros de otras campañas.

## Registro, concurrencia y reinicios

`CreditOverdueDataRecipient` conserva una clave SHA-256 derivada del celular. Su columna histórica `nextEligibleDate` ya no impone cadencia ni se actualiza para reservar los nuevos avisos. `CreditOverdueDataAttempt` conserva representante, mora, fecha, claim y resultado. `CreditOverdueDataCoverage`, con `creditoId` como clave primaria y `attemptId` como referencia, vincula todos los créditos cubiertos por el aviso. Estos registros no guardan nombre, celular en claro, payload, URL ni respuesta del proveedor.

El worker consulta tanto la cobertura como todos los intentos históricos por crédito. Reserva el único intento y todas las coberturas del grupo en una transacción, con bloqueo del receptor y de los créditos en orden. La restricción única receptor/fecha mantiene la deduplicación diaria, y la clave primaria de cobertura impide que dos procesos reserven el mismo crédito con celulares diferentes. La revalidación anterior a HTTP sólo usa coberturas del intento propio y elimina las que ya no son elegibles; nunca incorpora créditos nuevos sin reservar. HTTP ocurre fuera de la transacción.

Una respuesta explícita `ok:true` sin errores de nodo significa **aceptación del flujo, no entrega al celular**. HTTP fallido queda `FAILED`; timeout o respuesta ambigua queda `UNKNOWN`. Ambos conservan la cobertura y bloquean reenvíos del crédito. Un claim abandonado pasa a `UNKNOWN` al expirar y tampoco se reenvía por antigüedad.

Sólo el dueño que puede demostrar que no inició HTTP puede liberar un claim que aún sigue `CLAIMED` junto con sus coberturas. Eso permite un intento posterior si el crédito vuelve a cumplir la regla durante su día 20 y el celular no tiene otro envío ese día. No se eliminan resultados aceptados, fallidos o desconocidos. Una transacción fallida revierte conjuntamente el intento y las coberturas.

## Consulta sin mensajes

`GET /api/integraciones/dapta/datos` devuelve sólo contadores agregados y nunca escribe ni envía. Acepta `today=YYYY-MM-DD` para consulta histórica y requiere administrador central activo o token de cron/consulta en cabecera. El token de lectura de Diana nunca autoriza POST. La consulta también aplica el historial y la cobertura persistidos.

`POST` admite ejecución sólo con administrador central activo o token de cron. Es preview salvo `dryRun:false` explícito; fechas externas y límites se ignoran al enviar. Nunca acepta credenciales en la URL.

El predeploy mantiene las tablas existentes y crea idempotentemente la tabla de cobertura y sus índices. No borra historial ni modifica créditos, abonos o registros de otras campañas. Esta documentación describe la implementación; no confirma por sí sola su publicación o envíos reales.
