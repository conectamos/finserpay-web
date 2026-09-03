# Padlock para iPhone en mora

## Estado de la integración

La integración se entrega **apagada por defecto** y no está autorizada para
producción. La documentación recibida no incluye una URL de sandbox ni una URL
de producción verificables, por lo que ninguna credencial debe usarse hasta que
Padlock confirme el ambiente de certificación.

El interruptor principal es `PADLOCK_INTEGRATION_ENABLED=false`. Aun si se
configura por error una URL o credenciales, producción exige además
`PADLOCK_ALLOW_PRODUCTION=true`. Este segundo interruptor no reemplaza una
autorización operativa de FINSER PAY.

## Regla de negocio acordada

- Solo aplican créditos de iPhone con una vinculación Padlock explícita y
  verificada contra el IMEI exacto.
- Durante certificación solo se vinculan dispositivos que Padlock confirme
  enrolados, operativos y desbloqueados. Un bloqueo preexistente exige revisión
  y aclaración de su causa; nunca se atribuye automáticamente a mora.
- Tampoco se vincula un crédito que conserve los indicadores canónicos
  `bloqueoRobo` o `bloqueoMora` del control anterior. Esos estados deben
  conciliarse antes de transferir el control operativo a Padlock.
- Los bloqueos automáticos se evalúan únicamente los días 5 y 20 de cada mes a
  las 20:00, zona horaria `America/Bogota`.
- En el corte se vuelve a calcular la posición oficial del crédito usando
  únicamente abonos confirmados y no anulados. Si ya está al día, no se bloquea.
- Si el crédito continúa en mora y supera la política efectiva, se crea una
  orden de bloqueo en la cola. Nunca se llama a Padlock dentro de la transacción
  de Wompi, Efecty, recaudos o abonos.
- Cuando un pago confirmado deja el crédito al día, se cancela cualquier
  bloqueo automático aún no ejecutado y se crea de inmediato una orden de
  desbloqueo si el bloqueo vigente fue causado por mora. Operativamente, el
  evaluador lo detecta en el siguiente ciclo de 30 segundos; el tiempo final
  también depende de la respuesta de Padlock.
- El desbloqueo automático exige evidencia de un abono positivo, activo y
  creado después de la decisión de bloqueo por mora. Cambiar una fecha de pago,
  una cuota o el plan no se interpreta como pago confirmado.
- Una excepción de bloqueo por mora vigente evita nuevos bloqueos automáticos.
  Si la orden aún estaba pendiente o su resultado era incierto, se conserva una
  orden compensatoria de desbloqueo; una excepción, por sí sola, no levanta un
  bloqueo ya confirmado.
- El indicador canónico `bloqueoRobo` prevalece sobre Padlock: impide las
  decisiones automáticas y también un desbloqueo manual hasta que la causa por
  robo se retire en el flujo autorizado.
- Un bloqueo manual o por otra causa no se levanta automáticamente por un pago.
  Todo bloqueo o desbloqueo manual requiere un usuario autorizado y un motivo.
- Una vinculación Padlock activa asume el control remoto exclusivo de ese IMEI.
  Las rutas heredadas de Equality omiten o rechazan ese equipo antes de hacer
  I/O; Android y los equipos sin vinculación Padlock mantienen su flujo actual.
- El IMEI canónico de Padlock es exclusivamente el campo `identifier`; `key1`,
  `key2` y `serial` no se aceptan como sustitutos durante la vinculación.
- El comando requiere que el iPhone tenga internet. Si está apagado o sin red,
  Padlock conserva la acción y la aplica cuando el equipo se enciende y se
  conecta. Una vez Padlock haya mostrado `locking` o `unlocking`, FINSER PAY
  mantiene la orden pendiente y consulta con espera progresiva, sin reenviar
  el POST ni agotar la orden por el tiempo sin conexión.

La política puede definir días de gracia y días adicionales de mora. El umbral
efectivo es la suma de ambos valores. Con ambos en cero, basta con que el crédito
siga oficialmente en mora en el corte del 5 o del 20.

## Capacidades verificadas en la documentación de Padlock

La documentación PDF y la colección de Postman recibidas permiten verificar:

- autenticación con `POST /api/v1/auth/login`, usando correo, contraseña y
  tenant, que devuelve un JWT temporal;
- consulta de dispositivos con `GET /api/v1/enterprise/devices`, búsqueda y
  paginación, con límite documentado de hasta 100 registros por página;
- bloqueo con `POST /api/v1/devices/lock`;
- desbloqueo con `POST /api/v1/devices/unlock`;
- hasta 1.000 identificadores en una orden de bloqueo o desbloqueo;
- resultados por dispositivo y estados remotos `unlocked`, `locked`,
  `locking`, `unlocking`, `not_enrolled` y `error`.

Un HTTP 200 no confirma por sí solo el resultado: puede contener éxitos y fallos
parciales. FINSER PAY procesa inicialmente un IMEI por orden, revisa el resultado
individual y consulta el estado remoto hasta confirmar `locked` o `unlocked`.

Además de lo verificable en los adjuntos, FINSER PAY confirmó operativamente que
`identifier` es el campo canónico del IMEI y que los comandos pendientes se
aplican cuando el iPhone recupera conexión a internet.

## Información pendiente de Padlock

Antes de certificar hacen falta, por escrito:

1. URL HTTPS oficial de sandbox y URL HTTPS de producción.
2. Confirmación de que la cuenta y los endpoints entregados soportan iPhone/iOS;
   el ejemplo recibido muestra un dispositivo Android.
3. Procedimiento y requisitos de enrolamiento del iPhone.
4. SLA y tiempo máximo esperado para pasar de `locking`/`unlocking` al estado
   final.
5. Contrato de webhooks, firma y protección contra repetición. No se implementa
   un webhook hasta recibir ese contrato.
6. Política de expiración/revocación del JWT y rotación de credenciales.
7. Significado completo de los códigos de error documentados.

Las listas de créditos e IMEI de sandbox serán definidas internamente por
FINSER PAY; no se solicitan a Padlock.

La colección recibida usa `http://localhost:8000`; esa dirección es ilustrativa
y no se considera un ambiente de Padlock.

## Flujo técnico

1. **Evaluador:** revisa vinculaciones activas y calcula la posición oficial del
   crédito. El desbloqueo se evalúa en cada ciclo; el bloqueo solo dentro del
   corte permitido.
2. **Outbox:** registra la intención, versión deseada, causa, política aplicada y
   una fotografía financiera mínima. La clave idempotente evita órdenes
   duplicadas.
3. **Worker:** toma órdenes con lease de base de datos, vuelve a validar la
   posición del crédito y libera la transacción antes de invocar Padlock.
4. **Cliente:** obtiene/cacha el JWT solo en memoria, impone timeout, rechaza
   redirecciones y respuestas demasiado grandes, y nunca registra tokens ni
   credenciales.
5. **Conciliación:** ante timeout o estado transitorio consulta primero el estado
   remoto y nunca repite una orden cuyo resultado es incierto. Ver todavía el
   estado opuesto no prueba que el comando anterior haya sido descartado: la
   barrera se conserva hasta observar el estado objetivo. Si se agotan las
   consultas, el caso pasa a revisión sin liberar esa barrera; un administrador
   puede reanudar exclusivamente los GET con un motivo auditado.
6. **Auditoría:** conserva transiciones, correlación, actor, motivo y errores
   sanitizados. No conserva JWT, contraseña, payload HTTP crudo ni información
   personal innecesaria.

Las carreras se resuelven con una versión monotónica del estado deseado. Una
orden antigua no puede confirmar un bloqueo después de que un pago haya creado
una intención de desbloqueo más reciente. Los POST al proveedor también se
serializan por vinculación: una orden nueva no puede consultar ni actuar sobre
el mismo IMEI mientras un POST anterior siga abierto. Si un bloqueo termina
tarde, se registra su finalización y el desbloqueo compensatorio debe confirmarse
después de esa barrera. Un intento ambiguo jamás se reenvía y tampoco permite
retirar la vinculación. Si el equipo está sin conexión, la orden permanece
pendiente y las consultas continúan con un backoff máximo de quince minutos
hasta observar el estado final. Un timeout en el cual nunca se observó que
Padlock aceptara la transición sí conserva un límite de conciliación y pasa a
`REVIEW_REQUIRED`, sin reenviar el POST. Los desbloqueos tienen prioridad
absoluta sobre los bloqueos al tomar trabajo pendiente.

Desde la consola, un administrador central puede seleccionar uno de esos
intentos ambiguos, registrar el motivo de su revisión y reanudar otra ventana de
consultas. La acción conserva el intento remoto abierto y no modifica sus marcas
de inicio o terminación, por lo que el worker queda técnicamente obligado a usar
solo GET y no puede repetir el POST.

Si se confirma un pago mientras un `LOCK` aceptado espera que el iPhone vuelva
a tener internet, el `UNLOCK` compensatorio queda en cola detrás de esa orden.
Al reconectarse, el equipo podría bloquearse brevemente antes de que Padlock
aplique el desbloqueo; serializar ambas acciones evita invertirlas o perder una
de ellas.

Mientras no exista un contrato de webhooks, la conciliación automática se
concentra en órdenes pendientes, transitorias o inciertas. No se hace un sondeo
permanente de todos los equipos ya confirmados; por tanto, la certificación de
producción también debe acordar cómo detectar cambios remotos hechos fuera de
FINSER PAY.

El límite de mutaciones administrativas es local a cada proceso. Antes de usar
múltiples réplicas en producción se debe sustituir por un limitador compartido o
configurar el equivalente en el proxy de entrada. Los permisos, confirmaciones,
motivos obligatorios e idempotencia de base de datos siguen aplicando en cada
réplica.

### Disponibilidad del corte

El corte es deliberadamente estricto: solo el minuto de las 20:00 en Bogotá de
los días 5 y 20 puede crear bloqueos automáticos. El arranque de la aplicación
nunca recupera un bloqueo de forma retroactiva, porque hacerlo podría actuar con
una posición financiera distinta a la observada en el corte. Si todos los
procesos están fuera de servicio durante ese minuto, los bloqueos nuevos se
aplazan hasta el siguiente corte; las órdenes que ya estaban en la outbox sí se
recuperan y concilian al reiniciar.

Por esa razón, antes de habilitar la integración se debe monitorizar la
disponibilidad del scheduler durante ambos cortes y acordar si Padlock o la
infraestructura de FINSER PAY ofrecerán un disparador externo redundante. No se
amplía ni se recupera la ventana sin una decisión operativa explícita.

## Estados visibles

- `PENDING`: orden creada o conciliación/reintento en espera.
- `PROCESSING`: llamada o conciliación en curso.
- `LOCKED`: bloqueo confirmado por consulta a Padlock.
- `UNLOCKED`: desbloqueo confirmado por consulta a Padlock.
- `ERROR`: fallo terminal o no reintentable.
- `REVIEW_REQUIRED`: resultado ambiguo, dispositivo no enrolado, identidad no
  exacta u otra condición que exige intervención humana. Cuando conserva un
  intento remoto abierto, la consola permite reanudar solo su conciliación GET.

Las órdenes obsoletas también pueden quedar `CANCELLED` o `SUPERSEDED`; esos son
estados de auditoría y no afirman el estado físico del iPhone.

## Variables de entorno

Ninguna variable debe usar el prefijo `NEXT_PUBLIC_`.

| Variable | Uso |
| --- | --- |
| `PADLOCK_INTEGRATION_ENABLED` | Interruptor general. Debe iniciar en `false`. |
| `PADLOCK_ENVIRONMENT` | `sandbox` o `production`. |
| `PADLOCK_BASE_URL` | URL HTTPS oficial del ambiente, sin rutas añadidas. |
| `PADLOCK_EMAIL` | Correo técnico suministrado por Padlock. |
| `PADLOCK_PASSWORD` | Contraseña técnica suministrada por Padlock. |
| `PADLOCK_TENANT` | Tenant suministrado por Padlock. |
| `PADLOCK_TIMEOUT_MS` | Tiempo máximo por solicitud HTTP. |
| `PADLOCK_RESPONSE_MAX_BYTES` | Tamaño máximo aceptado para una respuesta. |
| `PADLOCK_ALLOW_PRODUCTION` | Segundo seguro; debe permanecer `false` durante certificación. |
| `PADLOCK_SANDBOX_ALLOWED_DEVICE_IDS` | IMEI autorizados en sandbox, separados por coma. |
| `PADLOCK_SANDBOX_ALLOWED_CREDIT_IDS` | Créditos autorizados en sandbox, separados por coma. |
| `FINSERPAY_INTERNAL_CRON` | Habilita el scheduler existente. En producción está activo por defecto; en local o pruebas debe configurarse en `true` si se quiere ejecutar la automatización. |

Las credenciales encontradas en un archivo de texto local no se copian al
repositorio ni a archivos `.env`. Deben trasladarse directamente al almacén de
secretos del ambiente autorizado y luego eliminarse de ese archivo local.

El esquema se prepara con `npm run db:setup-padlock` o como parte del predeploy
existente. Esta entrega valida el script y el modelo, pero no lo ejecuta contra
una base de datos real ni realiza llamadas al proveedor mientras falten la URL
oficial de sandbox y las allowlists internas de pruebas.

## Certificación de sandbox

La habilitación de sandbox requiere completar y documentar esta secuencia con un
iPhone y un crédito de prueba incluidos en ambas listas permitidas:

1. consultar el IMEI y exigir una coincidencia exacta única;
2. comprobar que el estado inicial sea `unlocked`; un equipo ya bloqueado se
   envía a revisión y no se vincula automáticamente;
3. comprobar que el crédito no conserve un bloqueo por robo o mora del control
   anterior;
4. crear una orden manual de bloqueo con motivo de certificación;
5. observar `locking` y confirmar posteriormente `locked`;
6. repetir para desbloqueo hasta confirmar `unlocked`;
7. simular mora antes de un corte y verificar que no haya bloqueo anticipado;
8. verificar bloqueo en un corte autorizado;
9. confirmar un pago, recalcular `AL_DIA` y verificar desbloqueo automático;
10. probar timeout, respuesta parcial, IMEI no enrolado y reintentos agotados;
11. revisar la auditoría y comprobar que no contenga secretos ni IMEI completos
    en vistas o logs.

Producción permanecerá deshabilitada hasta una autorización explícita posterior
y no forma parte de esta entrega.
