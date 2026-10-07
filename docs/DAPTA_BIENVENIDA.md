# Bienvenida automática de créditos

Al crearse un crédito nuevo mediante `POST /api/creditos`, FINSERPAY ya dispone de `clienteNombre` y `clienteTelefono`. Tras confirmar la transacción, el servidor puede enviar esos datos al flujo de Dapta **Bienvenida al finalizar crédito** (`ERPX5`). El reporte de créditos muestra los mismos datos, pero consultarlo o exportarlo no dispara mensajes.

El formulario **Crédito individual** dentro de Créditos masivos usa `POST /api/creditos/masivos` y confirma con `welcomeOnCreate: true`. Esa ruta solicita una bienvenida solo después de insertar y confirmar un crédito nuevo. Su replay por `requestId` devuelve el recibo guardado sin repetir el envío. La validación previa y los archivos CSV históricos (incluso de una fila) no solicitan bienvenidas. La confirmación del formulario informa que se enviará WhatsApp al celular registrado.

La integración empieza apagada. Para activarla se requieren estas variables privadas del servidor:

```text
DAPTA_BIENVENIDA_WEBHOOK_URL=<URL del webhook del flujo ERPX5>
DAPTA_BIENVENIDA_ENABLED=true
```

No use el prefijo `NEXT_PUBLIC_` ni registre la URL: incluye una credencial de Dapta. Active `DAPTA_BIENVENIDA_ENABLED` únicamente después de que Meta apruebe la plantilla `bienvenida` (`ad453419-dec2-4e74-83fe-19fed870332b`) y se verifique el número emisor. Mientras esté apagada, el alta del crédito no llama a Dapta.

El servidor envía `credito_id`, `telefono` normalizado a `57` + 10 dígitos y `nombre`. El flujo pone `nombre` en la variable `contact_name` de la plantilla. La llamada se hace una sola vez por el camino de creación de un crédito nuevo; fallar al contactar a Dapta no revierte el crédito. El resultado `accepted` indica que el webhook aceptó la solicitud, sin confirmar entrega por WhatsApp. Un error explícito de un nodo del flujo se registra como `failed`, aunque Dapta responda HTTP 200. Esta primera versión no reintenta envíos fallidos ni registra entregas confirmadas por WhatsApp. Si se necesita recuperación automática y trazabilidad, incorporar una cola persistente con control de duplicados antes de activar.
