# Atención: persistencia, permisos y operación

El CRM recibe conversaciones reales de WhatsApp y Meta mediante el conector de lectura de Dapta. Administración central supervisa la bandeja global y asigna conversaciones exclusivamente a cuentas nominales de analistas de aprobación. Cada analista consulta únicamente sus conversaciones asignadas. No se amplían los permisos de cartera, solicitudes, créditos o pagos.

## Instalación y actualización

El predeploy de Railway ejecuta scripts/ensure-atencion-schema.mjs. También puede ejecutarse mediante npm run db:setup-atencion, con DATABASE_URL disponible exclusivamente en el entorno del servidor.

El instalador toma un bloqueo de aplicación, verifica la estructura existente, aplica scripts/setup-atencion.sql en una transacción con search_path public y comprueba diez tablas, claves y trigger de auditoría: las siete originales y tres nuevas de Meta. Los arrays de metadatos usan text[] para ser compatibles con node-pg. Una estructura incompatible falla sin intentar reparaciones destructivas. No se ejecuta DDL durante las solicitudes. La configuración, activación pendiente y operación del canal directo se detallan en [ATENCION_META.md](ATENCION_META.md).

La actualización permite nulos en AttentionConversation.sedeId y phone. Acepta el esquema anterior con NOT NULL durante la verificación previa y exige las columnas nullable después del SQL. Conserva íntegramente chats, mensajes, responsables y sedes históricos. Las tablas financieras no se modifican.

Si falta el esquema, la bandeja devuelve schemaReady=false y los detalles/escrituras responden 503. La presencia del esquema no sustituye la validación de la cuenta.

## Tablas

| Tabla | Función |
| --- | --- |
| AttentionConversation | Gestión local, teléfono verificable opcional, responsable, versión y vínculo opcional a crédito |
| AttentionMessage | Texto permitido del proveedor, único por conversación e ID externo |
| AttentionNote | Notas internas con autor |
| AttentionTask | Recordatorios internos, vencimiento y finalización |
| AttentionQuickReply | Textos expresamente aprobados por administración central |
| AttentionAudit | Consultas y cambios con actor y fecha; trigger impide actualización y borrado |
| AttentionRequest | Idempotencia mediante actor, UUID y huella del contenido |

No existe una tabla paralela de clientes. Una nueva gestión interna, disponible solo para central, crea un caso internal pendiente sin responsable ni sede. Su nombre y teléfono proceden del formulario; no crea mensajes, estudios, clientes o créditos.

## Acceso y asignación

- Se usa getNominalApprovalWorkspaceSessionUser: ADMIN de FINSERPAY o ANALISTA_APROBACION con sesión nominal válida. Un enlace compartido de aprobación, incluso inválido, no autoriza acceso ni permite recurrir a una sesión administrativa adicional.
- Cada transacción vuelve a comprobar Usuario, Rol, Sede y Aliado activos. Una sesión anterior no conserva acceso tras desactivación o cambio de rol.
- Administración central utiliza la identidad admin:ID y ve la bandeja global. No es un destino de asignación.
- Los analistas utilizan analyst:ID. El acceso exige simultáneamente assigneeUserId igual a su Usuario, assigneeKey igual a su identidad y assigneeSellerId nulo. No ven chats sin asignar ni de otro analista.
- Vendedores, supervisores comerciales y administradores de aliados quedan excluidos. Las claves históricas user:ID o seller:ID no conceden permisos de analista.
- Solo central puede asignar, transferir o vincular fichas. El destino se verifica y bloquea transaccionalmente: Usuario activo, rol ANALISTA_APROBACION y Sede/Aliado FINSERPAY activos.
- Un analista puede iniciar, cerrar, reabrir y documentar sus chats asignados. La transferencia retira su acceso. No puede apropiarse de otro chat.
- Las asignaciones históricas permanecen registradas para revisión de central; no se reinterpretan como analistas ni se reasignan automáticamente.

## Ficha existente sin ampliar cartera

Central busca globalmente en Credito y CreditoBorrador por teléfono exacto normalizado. Solo se infiere +57 para móviles colombianos locales de diez dígitos. No se comparan sufijos. Un identificador opaco de Meta nunca se trata como teléfono: el chat se conserva con phone=null y sin ficha reconocida.

Documentos distintos, ausencia de identificación inequívoca o resultados excesivos dejan la coincidencia ambigua. Los borradores convertidos no cuentan como prospectos adicionales. Una ficha de prospecto muestra el estado existente o el estudio relacionado; no duplica solicitudes ni expone payload.

El analista recibe una ficha restringida hasta que central vincule explícitamente un crédito con teléfono coincidente. Después solo recibe ese crédito y sus estados de estudio permitidos, sin candidatos adicionales, créditos hermanos, importes, saldos ni abonos. Si el teléfono deja de coincidir, la ficha vuelve a estar restringida. La búsqueda por nombre respeta ese mismo vínculo: no revela otras identidades por un teléfono compartido.

Central puede revisar los créditos de la identidad seleccionada y sus finanzas mediante buildCreditPaymentPlan, usando el plan vigente, abonos activos no anulados y paz y salvo. Si faltan fecha inicial o plazo, no se inventa un calendario. No se devuelven payload, contratoSnapshot, documentos adjuntos, OTP, PIN, contraseñas o datos internos del proveedor.

No hay acción linkDraft ni editor paralelo de clientes. Una ambigüedad formada por borradores requiere revisión en el flujo existente de solicitudes, con sus permisos actuales.

## Sincronización y métricas

El conector se describe en [ATENCION_DAPTA.md](ATENCION_DAPTA.md). La lectura está configurada en el servicio. Solo central sincroniza, sin elegir una sede. Los nuevos chats llegan globalmente con sedeId=null y sin responsable. Una sede histórica se conserva, pero ya no define el permiso de Atención.

El proveedor puede aportar un teléfono nulo por canal Meta opaco. Si luego aporta un teléfono verificable, el registro puede completarlo; dos teléfonos verificables distintos para el mismo ID externo producen conflicto y requieren revisión. Un snapshot sin teléfono no borra uno ya verificado.

La sincronización recibe lotes del adaptador. La respuesta de persistencia informa imported y messagesImported. El cursor privado daptaMessagesCursor se guarda junto con los mensajes en la misma transacción; un error revierte ambos. Al terminar el historial, el adaptador relee y deduplica la última página para detectar mensajes posteriores. Los cursores no aparecen en los DTO ni en auditoría.

Los mensajes se insertan en lote y se deduplican por ID oficial. Se conservan responsables y gestión local. Un nuevo mensaje entrante posterior a closedAt reabre el caso en pendiente, aunque una nota haya cambiado updatedAt. La evidencia del modo IA/persona puede actualizarse, pero human_requested permanece como solicitud local, no como transferencia remota confirmada.

El dashboard usa exclusivamente información persistida dentro del alcance del actor:

- Volumen: conversaciones únicas con al menos un mensaje entrante por día, durante los últimos siete días de Bogotá.
- Equipo: analistas activos y cantidades reales de chats asignados sin cerrar y pendientes; no se inventan estados de presencia ni porcentajes.
- Actividad: eventos reales de asignación, gestión y sincronización auditados.
- En curso: hasta cinco conversaciones visibles sin cerrar. Los totales globales se calculan sin aplicar la búsqueda de la bandeja.

La bandeja pagina de 40 en 40. El detalle devuelve los últimos 500 mensajes y las últimas 300 notas; prioriza tareas pendientes por vencimiento y limita la lista a 300. historyTruncated, notesTruncated y tasksTruncated advierten los límites.

Las escrituras y auditoría comparten transacción. Las versiones evitan sobrescribir cambios concurrentes y los UUID hacen idempotentes los reintentos con el mismo contenido. Las consultas se auditan antes de devolver datos. Las notas, etiquetas y recordatorios son internos: no alteran registros financieros ni envían notificaciones automáticas. canSend=false y canHandoff=false; no se modifica ningún número ni proveedor de WhatsApp.

## Validación local

Las pruebas de atencion-core, atencion-storage y atencion-schema-installer usan PostgreSQL embebido PGlite y datos sintéticos, sin red ni credenciales reales. Cubren asignación exclusiva a analistas activos, aislamiento entre analistas, denegación de perfiles comerciales, cuentas revocadas, legado, idempotencia, control de versiones, auditoría, ficha explícita sin importes, prospectos, chats Meta sin teléfono, deduplicación en lote, cierre/reapertura, dashboard con alcance y upgrade nullable sin pérdida de datos.

npm run test:atencion añade los casos del adaptador, HTTP y navegación. El resultado final de TypeScript, interfaz y despliegue se verifica sobre el worktree integrado; este documento no presupone una publicación antes de completar esas comprobaciones.

La ruta del módulo es /dashboard/atencion y sus API están bajo /api/atencion. La navegación comercial no presenta el CRM a vendedores o aliados; el centro de analistas y administración central usan sus accesos nominales.
