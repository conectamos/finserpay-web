# Atención: persistencia local y permisos

Implementación preparada el 30 de octubre de 2026. El esquema se entrega para instalación manual; durante el desarrollo no se ejecutó contra una base real ni se importaron conversaciones de clientes.

## Instalación

Con la configuración del despliegue y `DATABASE_URL` cargada exclusivamente en el entorno del servidor:

```sh
node scripts/ensure-atencion-schema.mjs
```

El script aplica `scripts/setup-atencion.sql` en una transacción. No modifica tablas financieras ni conecta proveedores. Requiere que existan las tablas actuales `Sede`, `Usuario`, `Vendedor` y `Credito`. No hay DDL durante las peticiones: mientras falta el esquema, la bandeja devuelve `schemaReady=false` y las operaciones de detalle/escritura responden 503.

También está disponible `npm run db:setup-atencion`. Ninguno de estos comandos se ejecutó sobre producción durante esta implementación.

## Tablas agregadas

| Tabla | Función |
| --- | --- |
| `AttentionConversation` | Gestión local, teléfono E.164, sede, responsable, versión y enlace opcional al crédito existente |
| `AttentionMessage` | Copia de texto permitido del proveedor, única por conversación e ID externo |
| `AttentionNote` | Notas internas con autor usuario/vendedor |
| `AttentionTask` | Tareas y recordatorios internos, vencimiento y finalización |
| `AttentionQuickReply` | Textos expresamente aprobados por administración central |
| `AttentionAudit` | Consultas y cambios con actor/fecha; actualización y borrado bloqueados por trigger |
| `AttentionRequest` | Idempotencia de acciones mediante actor, UUID y huella del contenido |

No se crea una tabla de clientes. Una nueva gestión interna crea únicamente una conversación `internal`: no fabrica mensajes, estudios, clientes ni créditos. Su nombre y teléfono proceden del formulario del usuario.

## Acceso y ficha

- Se reutilizan `getDashboardAccess`, la sesión de `Usuario` y la sesión de `Vendedor`. La identidad de asignación distingue `user:ID` de `seller:ID` porque varios vendedores pueden compartir un usuario de acceso.
- Administración central puede consultar todas las sedes. Administración de aliado queda restringida a su aliado. Supervisión queda restringida a su aliado y sede. Los vendedores solo ven chats propios o todavía sin asignar de su sede.
- Un vendedor debe tomar un chat sin asignar antes de cambiarlo. Las transferencias verifican usuarios activos o asignaciones `SedeVendedor` activas en la sede del chat. Consultar o transferir un chat no concede acceso a créditos de otro asesor o sede.
- Las coincidencias usan el teléfono exacto normalizado, con inferencia de `+57` solamente para móviles colombianos locales de diez dígitos. No se comparan los últimos dígitos de teléfonos de otros países.
- La ficha consulta `Credito` y `CreditoBorrador`, dentro de la sede del chat y el alcance financiero del actor. Borradores ya convertidos no se cuentan como prospectos adicionales. La identidad se agrupa por documento normalizado; documentos distintos o registros sin identificación inequívoca se presentan como ambiguos.
- Una vinculación manual a crédito exige que siga coincidiendo en teléfono y alcance. Si el registro deja de ser visible, la ficha se muestra restringida. Los prospectos existentes permanecen en su borrador: se muestra su estado o el estudio relacionado mediante `dataCreditoAssessmentId`.
- No hay una acción `linkDraft` ni un editor paralelo de clientes. Una ambigüedad compuesta solamente por borradores se resuelve revisando el flujo existente de solicitudes con sus permisos; no se selecciona una identidad arbitrariamente ni se duplica un registro.
- Solo administradores reciben saldos, próximas cuotas y abonos. Se reutiliza `buildCreditPaymentPlan`, con el plan de capital vigente, abonos activos no anulados y estado de paz y salvo. Si faltan fecha inicial o plazo, no se inventa un plan: los valores calculados se devuelven nulos.
- Se seleccionan campos concretos. No se devuelve `payload`, `contratoSnapshot`, documentos adjuntos, OTP, PIN, contraseñas ni datos internos del proveedor.

## Semántica de la sincronización

El adaptador de Dapta está descrito en [ATENCION_DAPTA.md](ATENCION_DAPTA.md). Las importaciones solo las realiza administración central sobre una sede elegida explícitamente. Un ID externo existente no puede cambiar de sede o teléfono silenciosamente.

La consulta del proveedor procesa hasta 25 conversaciones por página. La bandeja local muestra páginas de 40. El cursor de mensajes por conversación se guarda en `AttentionConversation.daptaMessagesCursor`, solo en el servidor y en la misma transacción que los mensajes. La siguiente sincronización continúa desde ese punto; al llegar al final relee y deduplica la última página para detectar nuevos mensajes. Un fallo no adelanta el cursor. Los cursores no aparecen en la ficha, bandeja ni auditoría.

Los mensajes se insertan en lote y se deduplican por ID oficial. Los estados y responsables locales se conservan. Un mensaje entrante nuevo con fecha posterior a `closedAt` vuelve a poner el caso en pendiente, aunque después del cierre se hayan registrado notas. La evidencia de modo IA/persona puede actualizarse; una solicitud local `human_requested` no se transforma en una transferencia confirmada. Importar y responder son capacidades diferentes: `canSend=false` y `canHandoff=false`.

El detalle devuelve los últimos 500 mensajes y las últimas 300 notas. Las tareas priorizan las pendientes por vencimiento y se limitan a 300. Los indicadores `historyTruncated`, `notesTruncated` y `tasksTruncated` permiten advertir cuando existe más historial almacenado.

Las escrituras y su auditoría comparten transacción. La versión impide sobrescribir cambios concurrentes; los UUID de solicitud hacen seguros los reintentos con el mismo contenido. Las consultas se auditan antes de devolver datos. Los errores de proveedor no se convierten en mensajes enviados o gestiones guardadas.

Los recordatorios son internos: no envían notificaciones de WhatsApp ni activan campañas. Las etiquetas y notas pertenecen a la conversación, y aparecen junto a la ficha consultada; no se copian a registros financieros.

## Pruebas

```sh
node --test tests/atencion-core.test.mjs tests/atencion-storage.test.mjs
```

Las pruebas locales usan PostgreSQL embebido PGlite y datos sintéticos. Cubren esquema pendiente, alcances de aliado/sede/asesor, transferencias, idempotencia, versiones, auditoría inmutable, protección financiera, números ambiguos, prospectos existentes, búsqueda con permisos, tareas y sincronización de 300 mensajes. También verifican la reapertura basada en el momento real del cierre y los límites visibles de notas/tareas. No utilizan red ni credenciales de producción.

`npm run test:atencion` ejecuta además las pruebas del adaptador y de los handlers HTTP.

## Interfaz, rutas y archivos

La sección está en `/dashboard/atencion`. Reutiliza `AppShell`, los sidebars actuales, la barra de usuario, los controles de `finser-ui` y los tokens `--fp-*`. En móvil permite alternar entre bandeja, conversación y ficha. Las métricas cuentan exclusivamente gestiones visibles; no hay datos iniciales de clientes ni respuestas comerciales supuestamente aprobadas.

| Archivos | Cambio |
| --- | --- |
| `app/dashboard/atencion/page.tsx`, `attention-console.tsx`, `attention.module.css`, `loading.tsx` | Página, interfaz adaptable y estados de carga/error/vacío |
| `app/api/atencion/route.ts` | Consulta de bandeja y creación de gestión interna |
| `app/api/atencion/[id]/route.ts` | Detalle y cambios internos autorizados |
| `app/api/atencion/sync/route.ts` | Sincronización explícita de lectura para administración central |
| `app/api/atencion/quick-replies/route.ts` | Aprobación central de respuestas rápidas |
| `lib/atencion-types.ts`, `atencion-core.ts`, `atencion-storage.ts`, `atencion-http.ts`, `atencion-dapta.ts` | Contratos, validación, permisos, persistencia y conector oficial |
| `app/dashboard/_components/admin-sidebar.tsx`, `seller-commercial-dashboard.tsx`, `finser-navigation.tsx`, `admin-central-dashboard.tsx` | Enlace a Atención en navegación existente |
| `scripts/setup-atencion.sql`, `scripts/ensure-atencion-schema.mjs` | Preparación transaccional del esquema nuevo |
| `package.json` | Comandos de instalación del módulo y pruebas; sin nuevas dependencias |
| `tests/atencion-core.test.mjs`, `atencion-storage.test.mjs`, `atencion-http.test.mjs`, `atencion-dapta.test.mjs` | Validación aislada de dominio, PostgreSQL, HTTP y protocolo MCP |
| `docs/ATENCION_BACKEND.md`, `docs/ATENCION_DAPTA.md` | Operación, configuración pendiente, restricciones y fuentes oficiales |

Validación final del 30 de octubre de 2026: **44 pruebas aprobadas**, TypeScript global (`tsc --noEmit --incremental false`) y ESLint de archivos nuevos sin errores. Se revisó la interfaz en navegador de escritorio y a 390 píxeles: apertura de conversación/ficha, navegación de regreso, filtro vacío, ausencia de desbordamiento horizontal y conservación de una nota tras un error de guardado. El servidor de QA usó una ficha sintética claramente identificada, sin conexión a datos reales; no forma parte del producto ni de su despliegue.

No se ejecutó un despliegue ni la instalación sobre producción. Para ponerlo en servicio faltan instalar el esquema y configurar las tres variables de Dapta documentadas, verificar la clave de servicio y realizar la primera sincronización autorizada. La interfaz no presenta un acceso configurado como una conexión comprobada. Envío, pausa de IA y transferencia remota permanecen bloqueados hasta contar con mecanismos oficiales confirmados.
