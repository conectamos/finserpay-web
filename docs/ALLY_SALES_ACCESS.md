# Ventas del administrador aliado

El administrador aliado puede iniciar Nueva venta para Android o iPhone sin
entrar con un PIN de vendedor. Su cuenta, sede y aliado deben estar activos y
corresponder al contexto autenticado. La venta se registra a su usuario y sede,
con `vendedorId` nulo; no se crea ni se suplanta un perfil comercial.

Puede guardar, retomar, confirmar el IMEI, validar identidad, enviar el contrato,
completar entrega y finalizar sus propias solicitudes del mismo aliado. Las
lecturas del aliado mantienen su alcance existente; la nueva autorización de
escritura no permite operar solicitudes de vendedores u otros administradores.

Las decisiones de DataCrédito, coincidencia documental de Veriff, firma vigente,
restricciones de IMEI y términos firmados, enrolamiento y evidencias conservan
las mismas validaciones del servidor. Las correcciones y revisiones exclusivas
del administrador central siguen protegidas. El cierre continúa siendo atómico
y los reintentos recuperan la venta confirmada en lugar de duplicarla.

`npm run test:ally-sales` verifica el nuevo actor con datos aislados y proveedores
simulados, sin consultas pagas, envío real de contratos ni creación de créditos
en producción.
