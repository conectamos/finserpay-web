# Recordatorios automáticos de cuotas por WhatsApp

La plantilla aprobada de WhatsApp `1_dia_falta` (`519fa7a9-65ba-40a3-b114-56573f56abbd`) recuerda al cliente que mañana vence su próxima cuota y enlaza al portal de pagos. Sus variables son `contact_name` y `company_name`; no incluye monto ni fecha como campos variables.

La plantilla aprobada `hoyvence` (`456571d6-c63e-4f7b-91f6-5b15b9e6e9f5`) recuerda el vencimiento de hoy, ofrece el portal y Efecty y tiene botones **PAGAR** y **YA REALICE EL PAGO**. Usa las mismas variables `contact_name` y `company_name`.

La nueva campaña de dos días usa la plantilla `2dias` (`c2094fc8-9435-42f1-9360-524cc2d3ad83`), categoría `UTILITY`, idioma `es`, encabezado `IMAGE` y una sola variable: `contact_name` en la posición 1. **Estado verificado el 13 de octubre de 2026 a las 12:26 Colombia: Meta aprobada, Dapta ACTIVE y sendable=true.** El flujo `AaoWO`, «Recordatorio 2 días antes de la cuota», ya se creó y verificó con el nodo nativo WhatsApp v2, su canal, la imagen original y sólo esa variable. La aprobación y la configuración no acreditan entrega de mensajes reales.

El programador interno de `finserpay-web` conserva las campañas de víspera y Hoyvence a las **10:00 a. m., America/Bogota**, en paralelo con Datos. La nueva tarea de dos días se programa a la **1:00 p. m. (13:00), America/Bogota**, con ventana independiente 13:00–13:59. Si el servicio se reinicia, puede recuperar las campañas de las 10 hasta las 10:59 y la de las 13 hasta las 13:59; fuera de cada ventana no envía. Cada petición vuelve a comprobar su horario. La selección consulta directamente los créditos, sin descargar ni importar el Excel.

## Selección

Se comparte `resolveCarteraDaysPastDue` con la columna AD **Días vencidos** del Excel de Cartera, calculada con el plan de pagos vigente, los abonos no anulados y la fecha de Colombia. El nombre usa `clienteNombre`, igual a la columna D, y el teléfono usa `clienteTelefono`, igual a la columna F. Las cuotas vencidas pendientes tienen prioridad sobre una cuota futura. Se excluyen créditos pagados, con paz y salvo, anulados/cancelados, sin saldo, sin fecha contractual o plan vigente válido, o sin nombre y celular colombiano válido. Los créditos históricos también pueden participar.

La campaña `two_days_before_due` selecciona **AD = -2** y una próxima cuota pendiente que vence exactamente dos fechas calendario de Colombia después; envía `2dias` sólo en su ventana de las 13. `before_due` envía `1_dia_falta` con **AD = -1**, y `due_today` envía `hoyvence` con **AD = 0** y próxima cuota pendiente que vence hoy. Las tres requieren **W > 0**, donde W es `plan.pendingCount` (Cuotas pendientes), saldo pendiente y las exclusiones comunes. AD = 0 por sí solo puede corresponder a un crédito completamente pagado. Las tres usan D y F; sus selecciones son distintas para una misma fecha y la nueva campaña no incluye cuotas a un día, de hoy, vencidas o ya pagadas.

## Activación

Solo después de confirmar la aprobación de la plantilla, el flujo en Dapta y su número emisor, configurar estas variables privadas en `finserpay-web`:

```text
DAPTA_RECORDATORIO_1_DIA_WEBHOOK_URL=<webhook privado del flujo de recordatorio>
DAPTA_RECORDATORIO_1_DIA_ENABLED=true
DAPTA_HOYVENCE_WEBHOOK_URL=<webhook privado del flujo Hoyvence>
DAPTA_HOYVENCE_ENABLED=true
DAPTA_RECORDATORIO_2_DIAS_WEBHOOK_URL=<webhook privado del flujo 2 días>
DAPTA_RECORDATORIO_2_DIAS_ENABLED=true
```

La configuración privada del nuevo flujo se habilita con `DAPTA_RECORDATORIO_2_DIAS_ENABLED=true` después de verificar la aprobación de Meta y `sendable=true`; ningún otro valor activa el worker. Las campañas existentes conservan su configuración y horario.

Las URLs deben ser HTTPS de `api.dapta.ai`. Cada campaña tiene su propio webhook y activación, sin reutilizar los de otra campaña cuando falta configuración. Nunca usar variables `NEXT_PUBLIC_` ni escribir las URLs en registros. Cada flujo recibe `credito_id`, `telefono`, `nombre`, `cuota_numero` y `fecha_vencimiento`. Usa el nodo nativo de su plantilla con `channel_id` de Diana, el teléfono como `+{{normalizar_contacto.telefono}}` y las variables como pares `{key,value}`. `2dias` sólo recibe `contact_name`; no se le añade `company_name`. Conservar los atributos nativos y el encabezado de imagen, que generan el cuerpo de la solicitud.

## Prevención de duplicados

El predespliegue instala `CreditDueReminder`, con una restricción única por crédito, número original de cuota y plantilla. Se reserva la cuota antes de contactar a Dapta y se revalida su elegibilidad tras la reserva. La fecha del vencimiento se guarda como referencia; modificar esa fecha no permite repetir el mensaje de la misma cuota.

Las claves son `recordatorio_2_dias_antescuota`, `recordatorio_1_dia_falta_antescuota` y `recordatorio_hoyvence_cuota`. Una cuota puede recibir un aviso dos días antes, otro la víspera y otro al vencer, cada uno una sola vez y en su propio horario. El registro de una campaña no bloquea ni reintenta el de las otras. La tarea nueva del cron es `credit-due-two-days-reminders`, con clave diaria independiente de las tareas de las 10.

Cada registro permite un solo intento de red. Si la revalidación detecta un pago o cambio de fecha antes de contactar al proveedor, se libera únicamente esa reserva comprobada sin envío; puede participar en otra fecha válida para esa campaña. Una reserva interrumpida vence a los 90 segundos y queda `UNKNOWN`; no se reintenta automáticamente porque Dapta podría haber recibido el mensaje. La expiración sólo procesa la plantilla de la campaña seleccionada. `ACCEPTED` acredita aceptación del flujo, no entrega en WhatsApp; `FAILED` indica rechazo explícito y `UNKNOWN` un resultado incierto. Sólo se registran códigos de resultado y agregados, sin nombres, teléfonos, cuerpos de proveedor ni credenciales.

## Consulta y pruebas

`GET /api/integraciones/dapta/recordatorios-cuota` muestra únicamente contadores agregados, sin reservar ni enviar mensajes. Permite administrador, token de cron o el token de lectura de Diana. `?today=AAAA-MM-DD` sirve exclusivamente para previsualizar otra fecha.

GET admite `?campaign=before_due` (predeterminado), `?campaign=due_today` o `?campaign=two_days_before_due`. POST admite `campaign` con esos mismos valores en el cuerpo. Cualquier otra campaña se rechaza sin consultar cartera ni enviar. GET sigue siendo sólo lectura aunque incluya `dryRun=false` en la URL. El reporte identifica la campaña y su plantilla; el reloj y la configuración privada se evalúan por separado para cada una.

`POST` requiere administrador activo del aliado central FINSERPAY o `MORA_SYNC_TOKEN`/`CRON_SECRET` y comienza con `dryRun: true`. Los administradores de aliados no acceden a esta operación global. Un envío real exige `dryRun: false`, las variables de activación y el reloj real dentro de la ventana. El token de lectura de Diana nunca permite `POST`. Los cambios de fecha/limit en una solicitud no alteran un envío real.

Pruebas locales relevantes: `cartera-due-days`, `credit-due-reminder-policy`, `credit-due-reminders`, `credit-due-reminders-http`, `cartera-export-route`, `internal-cron-schedule` e `internal-cron-startup-window`. Cubren AD=-2, las ventanas 10/13, cuota pendiente, tres claves independientes, recuperación al arrancar, revalidación, concurrencia y autorización. Usar una base de prueba y solicitudes simuladas; no disparar la plantilla contra clientes para validar código.
