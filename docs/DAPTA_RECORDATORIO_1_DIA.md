# Recordatorios automáticos de cuotas por WhatsApp

La plantilla aprobada de WhatsApp `1_dia_falta` (`519fa7a9-65ba-40a3-b114-56573f56abbd`) recuerda al cliente que mañana vence su próxima cuota y enlaza al portal de pagos. Sus variables son `contact_name` y `company_name`; no incluye monto ni fecha como campos variables.

La plantilla aprobada `hoyvence` (`456571d6-c63e-4f7b-91f6-5b15b9e6e9f5`) recuerda el vencimiento de hoy, ofrece el portal y Efecty y tiene botones **PAGAR** y **YA REALICE EL PAGO**. Usa las mismas variables `contact_name` y `company_name`.

El programador interno de `finserpay-web` inicia ambas campañas a las **10:00 a. m., America/Bogota**. Se procesan en paralelo para que el volumen de una no retrase el inicio de la otra. Si el servicio se reinicia, puede recuperar el procesamiento hasta las 11:00 a. m. Cada envío comprueba nuevamente la ventana horaria. La selección consulta directamente los créditos, sin descargar ni importar el Excel.

## Selección

Se comparte `resolveCarteraDaysPastDue` con la columna AD **Días vencidos** del Excel de Cartera, calculada con el plan de pagos vigente, los abonos no anulados y la fecha de Colombia. El nombre usa `clienteNombre`, igual a la columna D, y el teléfono usa `clienteTelefono`, igual a la columna F. Las cuotas vencidas pendientes tienen prioridad sobre una cuota futura. Se excluyen créditos pagados, con paz y salvo, anulados/cancelados, sin saldo, sin fecha contractual o plan vigente válido, o sin nombre y celular colombiano válido. Los créditos históricos también pueden participar.

La campaña `before_due` envía `1_dia_falta` con **AD = -1**. La campaña `due_today` envía `hoyvence` con **AD = 0 y W > 0**, donde W es `plan.pendingCount` (Cuotas pendientes). También verifica que la próxima cuota pendiente venza hoy: AD = 0 por sí solo puede corresponder a un crédito completamente pagado. Ambas campañas usan D y F y las exclusiones comunes; sus selecciones son distintas para una misma fecha.

## Activación

La integración comienza apagada. Solo después de confirmar el flujo en Dapta y su número emisor, configurar estas variables privadas en `finserpay-web`:

```text
DAPTA_RECORDATORIO_1_DIA_WEBHOOK_URL=<webhook privado del flujo de recordatorio>
DAPTA_RECORDATORIO_1_DIA_ENABLED=true
DAPTA_HOYVENCE_WEBHOOK_URL=<webhook privado del flujo Hoyvence>
DAPTA_HOYVENCE_ENABLED=true
```

Las URLs deben ser HTTPS de `api.dapta.ai`. Cada campaña tiene su propio webhook y activación, sin reutilizar el webhook de la otra cuando falta configuración. Nunca usar variables `NEXT_PUBLIC_` ni escribir las URLs en registros. Cada flujo recibe `credito_id`, `telefono`, `nombre`, `cuota_numero` y `fecha_vencimiento`. Usa el nodo nativo de su plantilla con `channel_id` de Diana, el teléfono como `+{{normalizar_contacto.telefono}}` y las variables como pares `{key,value}`. Conservar los atributos del nodo nativo, que generan el cuerpo de la solicitud.

## Prevención de duplicados

El predespliegue instala `CreditDueReminder`, con una restricción única por crédito, número original de cuota y plantilla. Se reserva la cuota antes de contactar a Dapta y se revalida su elegibilidad tras la reserva. La fecha del vencimiento se guarda como referencia; modificar esa fecha no permite repetir el mensaje de la misma cuota.

Las claves son `recordatorio_1_dia_falta_antescuota` y `recordatorio_hoyvence_cuota`. Una cuota puede recibir un aviso la víspera y otro el día de vencimiento, cada uno una sola vez. El registro de la víspera no bloquea el del día siguiente.

Cada registro permite un solo intento de red. Si la revalidación detecta un pago o cambio de fecha antes de contactar al proveedor, se libera únicamente esa reserva comprobada sin envío; puede participar en una futura víspera válida. Una reserva interrumpida vence a los 90 segundos y queda `UNKNOWN`; no se reintenta automáticamente porque Dapta podría haber recibido el mensaje. `ACCEPTED` acredita aceptación del flujo, no entrega en WhatsApp; `FAILED` indica rechazo explícito y `UNKNOWN` un resultado incierto. Solo se registran códigos de resultado y agregados, sin nombres, teléfonos, cuerpos de proveedor ni credenciales.

## Consulta y pruebas

`GET /api/integraciones/dapta/recordatorios-cuota` muestra únicamente contadores agregados, sin reservar ni enviar mensajes. Permite administrador, token de cron o el token de lectura de Diana. `?today=AAAA-MM-DD` sirve exclusivamente para previsualizar otra fecha.

GET admite `?campaign=before_due` (predeterminado) o `?campaign=due_today`. POST admite `campaign` con esos mismos valores en el cuerpo. Cualquier otra campaña se rechaza sin consultar cartera ni enviar. El reporte identifica la campaña y su plantilla; el reloj y la configuración privada se evalúan por separado para cada una.

`POST` requiere administrador activo del aliado central FINSERPAY o `MORA_SYNC_TOKEN`/`CRON_SECRET` y comienza con `dryRun: true`. Los administradores de aliados no acceden a esta operación global. Un envío real exige `dryRun: false`, las variables de activación y el reloj real dentro de la ventana. El token de lectura de Diana nunca permite `POST`. Los cambios de fecha/limit en una solicitud no alteran un envío real.

Pruebas locales relevantes: `cartera-due-days`, `credit-due-reminder-policy`, `credit-due-reminders`, `credit-due-reminders-http`, `cartera-export-route` e `internal-cron-startup-window`. Usar una base de prueba y solicitudes simuladas; no disparar la plantilla contra clientes para validar código.
