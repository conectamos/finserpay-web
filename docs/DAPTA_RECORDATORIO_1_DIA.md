# Recordatorio automático un día antes de la cuota

La plantilla aprobada de WhatsApp `1_dia_falta` (`519fa7a9-65ba-40a3-b114-56573f56abbd`) recuerda al cliente que mañana vence su próxima cuota y enlaza al portal de pagos. Sus variables son `contact_name` y `company_name`; no incluye monto ni fecha como campos variables.

El programador interno de `finserpay-web` inicia la selección a las **10:00 a. m., America/Bogota**. Si el servicio se reinicia, puede recuperar el procesamiento hasta las 11:00 a. m. Cada envío comprueba nuevamente la ventana horaria. La selección consulta directamente los créditos, sin descargar ni importar el Excel.

## Selección

Se comparte `resolveCarteraDaysPastDue` con la columna AD **Días vencidos** del Excel de Cartera. Solo se incluyen filas con valor **-1**, calculadas con el plan de pagos vigente, los abonos no anulados y la fecha de Colombia. El nombre usa `clienteNombre`, igual a la columna D, y el teléfono usa `clienteTelefono`, igual a la columna F. Las cuotas vencidas pendientes tienen prioridad sobre una cuota futura. Se excluyen créditos pagados, con paz y salvo, anulados/cancelados, sin saldo, sin fecha contractual o plan vigente válido, o sin nombre y celular colombiano válido. Los créditos históricos también pueden participar.

## Activación

La integración comienza apagada. Solo después de confirmar el flujo en Dapta y su número emisor, configurar estas variables privadas en `finserpay-web`:

```text
DAPTA_RECORDATORIO_1_DIA_WEBHOOK_URL=<webhook privado del flujo de recordatorio>
DAPTA_RECORDATORIO_1_DIA_ENABLED=true
```

La URL debe ser HTTPS de `api.dapta.ai`. Nunca usar variables `NEXT_PUBLIC_` ni escribir la URL en registros. El flujo recibe `credito_id`, `telefono`, `nombre`, `cuota_numero` y `fecha_vencimiento`. Usa el nodo nativo de plantilla con `channel_id` de Diana, el teléfono como `+{{normalizar_contacto.telefono}}` y las variables como pares `{key,value}`. Conservar los atributos del nodo nativo, que generan el cuerpo de la solicitud.

## Prevención de duplicados

El predespliegue instala `CreditDueReminder`, con una restricción única por crédito, número original de cuota y plantilla. Se reserva la cuota antes de contactar a Dapta y se revalida su elegibilidad tras la reserva. La fecha del vencimiento se guarda como referencia; modificar esa fecha no permite repetir el mensaje de la misma cuota.

Cada registro permite un solo intento de red. Si la revalidación detecta un pago o cambio de fecha antes de contactar al proveedor, se libera únicamente esa reserva comprobada sin envío; puede participar en una futura víspera válida. Una reserva interrumpida vence a los 90 segundos y queda `UNKNOWN`; no se reintenta automáticamente porque Dapta podría haber recibido el mensaje. `ACCEPTED` acredita aceptación del flujo, no entrega en WhatsApp; `FAILED` indica rechazo explícito y `UNKNOWN` un resultado incierto. Solo se registran códigos de resultado y agregados, sin nombres, teléfonos, cuerpos de proveedor ni credenciales.

## Consulta y pruebas

`GET /api/integraciones/dapta/recordatorios-cuota` muestra únicamente contadores agregados, sin reservar ni enviar mensajes. Permite administrador, token de cron o el token de lectura de Diana. `?today=AAAA-MM-DD` sirve exclusivamente para previsualizar otra fecha.

`POST` requiere administrador activo del aliado central FINSERPAY o `MORA_SYNC_TOKEN`/`CRON_SECRET` y comienza con `dryRun: true`. Los administradores de aliados no acceden a esta operación global. Un envío real exige `dryRun: false`, las variables de activación y el reloj real dentro de la ventana. El token de lectura de Diana nunca permite `POST`. Los cambios de fecha/limit en una solicitud no alteran un envío real.

Pruebas locales relevantes: `cartera-due-days`, `credit-due-reminder-policy`, `credit-due-reminders`, `credit-due-reminders-http`, `cartera-export-route` e `internal-cron-startup-window`. Usar una base de prueba y solicitudes simuladas; no disparar la plantilla contra clientes para validar código.
