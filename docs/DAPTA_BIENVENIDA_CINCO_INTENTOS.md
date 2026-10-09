# Bienvenida inmediata y seguimiento de contacto

La política pura `planCreditWelcomeVoiceFollowup`, en `lib/credit-welcome-voice-followup-core.ts`, calcula la elegibilidad. No llama a Dapta, no escribe en la base de datos ni cambia aprobaciones. La cola duradera, el bloqueo de filas, la correlación del callback y la única solicitud externa por evento pertenecen al store y al worker.

## Contrato de integración

Entrada: `now`, fase persistida `FAST | PENDING | CONTACTED | STOPPED | HELD`, `fastAttempts`, último evento del seguimiento, `lastPendingSlot` y, si corresponde, `holdReason`. Salida: `phase`, `shouldDispatch`, `nextAttemptAt` en UTC, `pendingSlot` local de Bogotá y un código `reason` sin datos del cliente.

`getCreditWelcomeVoicePendingSlot(now)` devuelve únicamente la franja diaria actualmente abierta o `null`. Sirve para comparar la franja de un evento PENDING ya reclamado antes y después de revalidar datos; no vuelve a planificar un DISPATCHING ni autoriza por sí solo una llamada.

El store cuenta únicamente solicitudes reales de FAST, incluyendo la bienvenida inicial. Excluye `CONTROLLED_TEST`, intentos diarios PENDING y fallos locales que acreditan que no se hizo la solicitud. Un evento DISPATCHING sin respuesta permanece en curso; la ausencia de recibo no permite redespacharlo. Los contadores y fases se actualizan bajo el mismo bloqueo que el ledger de eventos, nunca desde parámetros del cliente.

`lastEvent.communicationOutcome`, `identityVerifiedAt` y `completedAt` son datos del backend. Los resultados terminales y su fecha provienen exclusivamente del callback autenticado y correlacionado. Los indicadores del modelo, como `identity_confirmed` o `call_successful`, no constituyen prueba de identidad ni de comunicación. El core ignora defensivamente un último evento `CONTROLLED_TEST`; el store debe seleccionar el último evento real del seguimiento y excluir las pruebas también del contador.

## Cinco intentos y cola diaria

FAST comienza inmediatamente. El evento inicial NORMAL/PENDING o INDIVIDUAL_IMPORT/PENDING se reutiliza, no se reemplaza con otro. Después de cada resultado terminal `NO_ANSWER`, los intentos segundo al quinto quedan habilitados cinco minutos después de su `completedAt` autenticado. Un reinicio puede ejecutar un intento vencido, pero no inventa ni acumula llamadas perdidas: la siguiente espera comienza con el resultado de la llamada que realmente se hizo.

Después del quinto intento total, la fase pasa a PENDING. Sus horarios son 08:00, 10:00, 14:00 y 17:00 en `America/Bogota`, con diez minutos de ventana. La primera franja debe comenzar estrictamente después del último resultado; así, terminar el quinto intento a las 14:02 no autoriza un sexto dentro de esa misma franja. Cada franja admite un intento por contacto y no se recuperan horarios que ya terminaron. La fase continúa diariamente mientras los resultados auténticos sean `NO_ANSWER`.

## Parada y conciliación

La identidad verificada por FINSERPAY o el resultado `HUMAN_CONTACT` dejan el contacto en CONTACTED. Una negativa explícita registrada por el backend lo deja en STOPPED y prevalece sobre contacto anterior. Estos estados no vuelven a programarse por un callback posterior de ausencia de respuesta.

DISPATCHING y ACCEPTED mantienen su fase, sin otra llamada elegible. UNKNOWN queda retenido con motivo `UNKNOWN_CALL`; la antigüedad nunca lo convierte en ausencia de respuesta. Un callback tardío autenticado puede recuperar FAST o PENDING desde `retryPhase`; cuando una bienvenida inicial antigua no tiene ese campo, se infiere desde el contador real y `lastPendingSlot`. Las retenciones por cambio de contacto, condiciones o resultado terminal ambiguo permanecen retenidas y requieren revisión; no se levantan por un callback de ausencia de respuesta.

Antes de cada solicitud externa, el store vuelve a validar estado del crédito, saldo, snapshot contractual, teléfono y exclusiones, y el worker vuelve a comprobar elegibilidad y ventana después de esa lectura. Un crédito pagado, anulado o excluido no recibe llamada. La revisión `APPROVED` no bloquea por sí sola la bienvenida: este seguimiento es independiente de la campaña de solicitudes pendientes y no modifica `CreditApprovalReview`.

La política y sus pruebas locales no demuestran entrega telefónica, calidad del audio ni corrección de la despedida del proveedor. La activación y cualquier incorporación excepcional de créditos anteriores requieren su configuración y selección explícitas; este documento no activa ninguna llamada.
