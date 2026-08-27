# Portal de enrolamiento iPhone

## Objetivo

El portal permite que el personal especializado confirme el enrolamiento de un
iPhone sin utilizar el inicio de sesión general de FINSER PAY. El equipo utiliza
un único enlace compartido y reutilizable. Cada confirmación se vincula a una
solicitud mediante la cédula y el IMEI exactos, y la fábrica de créditos la
recibe automáticamente.

La confirmación de enrolamiento no cambia la solicitud a `APROBADA`. La
solicitud permanece en proceso y solo pasa a `APROBADA` cuando el crédito se
finaliza.

## Configuración

El despliegue debe definir secretos distintos:

- `IPHONE_ENROLLMENT_ENABLED=true`: habilita el módulo.
- `IPHONE_ENROLLMENT_SHARED_ACCESS_SECRET`: token aleatorio Base64URL de al
  menos 256 bits. Forma el acceso que se comparte una sola vez con el equipo de
  enrolamiento. Rotarlo revoca el enlace compartido y sus sesiones activas, pero
  no invalida revisiones históricas ya guardadas.
- `IPHONE_ENROLLMENT_SESSION_SECRET`: secreto aleatorio de al menos 32
  caracteres para firmar sesiones y tokens temporales de cada caso. Rotarlo
  cierra todas las sesiones activas.
- `IPHONE_ENROLLMENT_IDENTITY_PEPPER`: secreto aleatorio estable de al menos
  32 caracteres para las huellas de cédula, IMEI y auditoría. No debe rotarse sin
  una migración explícita de las revisiones existentes.
- `IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION`: identificador corto de la versión
  del pepper, por ejemplo `v1`.
- `IPHONE_ENROLLMENT_PUBLIC_ORIGIN`: origen público canónico del portal, sin
  ruta; en producción debe ser `https://finserpay.com`.

Los secretos de sesión, acceso e identidad deben ser independientes. La API
administrativa solo entrega el enlace al administrador central y nunca lo
incluye en listados públicos ni logs.

## Acceso compartido

1. Un administrador central FINSER PAY abre
   `/dashboard/integraciones/enrolamiento-iphone`.
2. Copia el acceso compartido.
3. Lo entrega una sola vez al equipo especializado.
4. Todos los especialistas utilizan ese mismo enlace sin usuario ni contraseña.

No se crean autorizaciones por analista ni enlaces de un solo uso. El enlace
incluye el secreto en el fragmento `#acceso=`, por lo que el navegador no lo
envía como parte de la URL HTTP ni del encabezado de referencia. Al abrirlo, el
servidor establece una cookie `HttpOnly`, `Secure` y `SameSite=Strict` por
ocho horas.

## Flujo del especialista

1. Abre el acceso compartido.
2. Ingresa la cédula y el IMEI de 15 dígitos.
3. El sistema solo carga una solicitud iPhone abierta que corresponda al paso
   4 visible de enrolamiento (`currentStep >= 5`). Además, valida en el
   servidor DataCrédito aprobado, Veriff aprobado con coincidencia estricta de
   cédula y un proceso FirmaSeguro completado para la misma cédula e IMEI.
4. El portal muestra `APROBADA · SOLO FALTA ENROLAR`.
5. El especialista realiza la prueba de enrolamiento.
6. Cuando termina al 100 %, confirma `ENROLADO CORRECTAMENTE`.
7. La fábrica del asesor consulta la constancia cada ocho segundos y habilita
   automáticamente las cinco fotografías obligatorias para cerrar el crédito.

Si el caso todavía no llegó al paso 4, el portal lo informa y no permite
confirmarlo. Si el crédito ya fue finalizado, informa que es histórico y no lo
modifica.

El portal no muestra puntajes, fotografías, información financiera, teléfonos,
correo ni dirección. Consultarlo no ejecuta una nueva llamada a DataCrédito.

## Controles de integridad

- El token del caso queda ligado al acceso compartido y a la sesión exacta.
- La revisión se guarda una sola vez por solicitud y usa fecha del servidor.
- La aprobación revalida bajo transacción que el borrador sigue abierto, en el
  paso de enrolamiento, con la misma cédula e IMEI, el contrato firmado y la
  validación facial aprobada.
- Un cambio de cédula o IMEI invalida la revisión para el cierre.
- La creación final del crédito consulta la revisión del servidor e ignora
  cualquier bandera enviada por el navegador del asesor.
- Las consultas y confirmaciones tienen límites por sesión y límites durables
  agregados para todo el acceso compartido, aunque se abran varias sesiones.
- Las revisiones creadas con el acceso compartido llevan una huella HMAC
  histórica estable; rotar el enlace invalida sesiones, no la auditoría ya
  guardada.
- El secreto compartido se compara en tiempo constante y los valores inválidos
  se rechazan antes de consultar la base de datos.
- La página y sus API usan `no-store`, no se indexan y no pueden embeberse en
  un `iframe`.
