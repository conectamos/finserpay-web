# Llamadas de confirmación a solicitudes pendientes

La campaña llama a un lote cerrado de créditos ya finalizados que siguen pendientes de revisión. Utiliza a Diana y sus herramientas de identidad y condiciones contractuales. No aprueba créditos ni modifica sus condiciones.

## Horario

La zona es `America/Bogota`. Desde `startDate`, los lotes comienzan diariamente a las 08:00, 10:00, 14:00 y 17:00, mientras queden contactos activos. Cada lote admite despachos durante diez minutos; un reinicio no reproduce franjas anteriores. El cron del servidor comprueba la cola cada treinta segundos y despacha hasta tres contactos por tanda.

Un operador puede autorizar un intento inmediato para una campaña concreta registrando una ventana en `VoiceReviewCampaignManualWindow`, con su franja local, inicio, caducidad de hasta diez minutos y motivo. No hay un endpoint público para crear esa autorización. Tanto la selección como la preparación vuelven a comprobar la ventana vigente; sin ella, fuera de los horarios normales no sale ninguna llamada. El intento conserva la fuente `SCHEDULED_CAMPAIGN`, un evento y token propios y la unicidad por crédito y franja. La ventana no cambia los reintentos normales ni habilita las llamadas generales a créditos nuevos.

## Activación independiente

Configurar en el servicio permanente `finserpay-web`:

- `DAPTA_VOICE_REVIEW_CAMPAIGN_ENABLED=true`.
- `DAPTA_VOICE_REVIEW_CAMPAIGN_JSON` con exactamente `id`, `startDate` (fecha ISO) y `creditIds` (IDs internos únicos del lote autorizado).
- Las variables privadas existentes `DAPTA_WELCOME_VOICE_WEBHOOK_URL`, `DAPTA_WELCOME_VOICE_TOKEN_SECRET` y `DAPTA_WELCOME_VOICE_AGENT_ID`.

La activación del lote no cambia `DAPTA_WELCOME_VOICE_ENABLED`: las llamadas generales para créditos nuevos pueden permanecer apagadas. El servidor conserva los integrantes y la fecha inicial de forma inmutable. Cambiar el contenido con el mismo ID provoca un conflicto y no incorpora clientes nuevos.

Antes de activar, comprobar la selección contra el muro de aprobaciones: `CreditApprovalReview=PENDING`, crédito vigente, contrato, amortización y celular válidos. El lote inicial solicitado el 9 de octubre de 2026 contiene trece créditos; excluye el pendiente anulado.

## Intentos y parada

Cada franja tiene como máximo un intento por crédito, con UUID y token nuevos. Las restricciones de base de datos y los bloqueos evitan que dos instancias reclamen el mismo contacto. Las pruebas `CONTROLLED_TEST` anteriores no cuentan como contacto de esta campaña.

Solo se reintenta automáticamente una ausencia de respuesta confirmada: ocupado, sin contestar, fallo de marcación o buzón, sin evidencia contradictoria de una conversación. La identidad verificada por FINSERPAY o una conversación humana acreditada detienen las llamadas; una negativa o una solicitud de no volver a llamar también las detienen. Esto registra comunicación, no conformidad con el contrato.

Los resultados ambiguos, callbacks ausentes y llamadas en curso permanecen retenidos. No se convierten en «sin contestar» por antigüedad o duración. Su resolución requiere el resultado autenticado de Dapta o revisión del operador. `TERMS_REVIEWED`, `COMPLETED` y `call_successful` por sí solos no acreditan comunicación.

Antes de cada despacho se vuelve a comprobar la revisión pendiente, el estado del crédito y su snapshot. Una anulación, liquidación, aprobación o cambio de contacto/condiciones impide la llamada. Cada resultado queda en el expediente de bienvenida con su enlace privado de Dapta cuando esté disponible; no se adjunta un audio descargado ni se aprueba automáticamente la solicitud.

## Verificación de puesta en marcha

Tras el despliegue, comprobar en Railway que la versión esté `SUCCESS`, que el cron haya persistido `VoiceReviewCampaign` y sus trece integrantes y que antes de las 08:00 no existan intentos `SCHEDULED_CAMPAIGN`. Confirmar que la bienvenida global conserve su valor previo. Los logs operativos contienen cantidades y códigos, nunca cédulas, teléfonos, snapshots o tokens.

La campaña corre en Railway y no depende de que el PC o Codex permanezcan abiertos. Las incidencias del proveedor, incluyendo audio o finalización de llamada, siguen siendo observables en Dapta; habilitar el calendario no demuestra que dichas incidencias hayan sido corregidas.
