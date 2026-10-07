# Campaña Datos para clientes con mora de 20 días o más

## Selección y horario

- Lee nombre, celular y mora directamente de los créditos y abonos de Cartera.
- Aplica la misma regla de Mora del resumen: días desde la cuota más antigua que aún tiene saldo pendiente, en calendario de Colombia.
- Selecciona mora **mayor o igual a 20**. Excluye créditos anulados, pagados, con paz y salvo, sin saldo o sin un plan/calendario financiero válido.
- Usa `clienteTelefono`, no teléfonos de referencia, y valida celular colombiano.
- Agrupa por celular normalizado: un mensaje por cliente/celular aunque haya varios créditos. Escoge el crédito de mayor mora; ante empate, el menor ID.
- Revisa diariamente a las **10:00 a. m. America/Bogota**, con recuperación durante 10:00–10:59. El worker solo intenta el envío cuando el cliente no tiene un intento en los tres días calendario anteriores.
- Ejemplo: un intento el 7 de octubre permite el siguiente el 10 de octubre a las 10:00, aunque el primer lote terminó a las 10:30. Una demora de minutos no desplaza la campaña a un cuarto día.
- Antes de cada petición vuelve a consultar crédito, abonos y teléfono. Si la mora baja de 20 o el crédito queda pagado, no envía.

El primer envío se hace en la primera ventana habilitada. Los clientes que después entren en el filtro comienzan su propio intervalo de tres días. No hace falta exportar ni subir Excel.

## Plantilla existente y flujo

Workspace: FINSERPAY (`7496b9a3-2fe6-4e28-8411-7d54ee788b2c`).

La campaña se llama **Datos**. La plantilla aprobada en Meta tiene el nombre técnico **`data`**, ID `292ba826-2bbc-43d2-abcc-c8e5d5253ca7`; contiene un aviso previo de reporte negativo. Se conserva su texto aprobado, que menciona 20 días desde el aviso: ese texto no debe confundirse con el filtro de 20 días de mora ni autoriza una operación de reporte a centrales. Esta integración únicamente envía la plantilla.

El flujo recibe POST con `credito_id`, `telefono`, `nombre` y `dias_mora`, normaliza contacto, exige mora >=20, ejecuta el nodo nativo de envío de plantilla y responde `ok: true`. Canal: agente Diana. Variable única: `contact_name`; el teléfono se pasa como string `+{{normalizar_contacto.telefono}}`. No se añaden variables inexistentes ni se vacían los atributos del nodo nativo.

## Configuración privada

Variables del servicio `finserpay-web` en Railway:

- `DAPTA_DATOS_ENABLED=true` para activar; ausente o cualquier otro valor no envía.
- `DAPTA_DATOS_WEBHOOK_URL`: URL privada del nuevo flujo, con credencial integrada.
- `DAPTA_DATOS_START_DATE=YYYY-MM-DD` opcional: impide envíos antes de la primera fecha acordada; una fecha imposible bloquea el envío. Para activar después de las 10:00, fijar mañana y conservar así el primer envío a las 10:00.

No guardar la URL privada ni la credencial en Git, documentación o logs. Solo se aceptan URL HTTPS de `api.dapta.ai`, sin userinfo/puerto, y no se siguen redirecciones. Las otras campañas conservan sus variables y registros.

## Registro y concurrencia

`CreditOverdueDataRecipient` conserva una clave SHA-256 derivada del celular y la próxima fecha habilitada. `CreditOverdueDataAttempt` conserva crédito, mora, fecha, claim y resultado; no conserva nombre, celular en claro, payload, URL ni respuesta del proveedor.

El claim y la próxima fecha se reservan en una transacción con bloqueo del receptor y revalidación financiera. La restricción única receptor/fecha y el bloqueo evitan duplicados entre procesos o reinicios. HTTP ocurre fuera de la transacción.

Una respuesta explícita `ok:true` sin errores de nodo significa **aceptación**, no entrega al celular. HTTP fallido se registra FAILED; timeout/respuesta ambigua, UNKNOWN. No se reintenta el mismo día: en ambos casos se conserva el intervalo de tres días. Un claim abandonado expira a UNKNOWN. Solo el dueño que sabe que no comenzó HTTP puede liberar su claim aún CLAIMED y restaurar la fecha previa; nunca elimina un resultado aceptado, fallido o desconocido.

## Consulta sin mensajes

`GET /api/integraciones/dapta/datos` devuelve solo contadores agregados y nunca escribe ni envía. Acepta `today=YYYY-MM-DD` para consulta histórica y requiere administrador central activo o token de cron/consulta en cabecera. El token de lectura de Diana nunca autoriza POST.

`POST` admite ejecución solo con administrador central activo o token de cron. Es preview salvo `dryRun:false` explícito; fechas externas y límites se ignoran al enviar. Nunca acepta credenciales en la URL.

El predeploy instala únicamente las dos tablas e índice nuevos mediante un script idempotente; no modifica créditos, abonos ni tablas de recordatorios existentes.
