# Portal de enrolamiento iPhone

## Objetivo

El portal permite que el personal especializado apruebe el enrolamiento de un
iPhone sin utilizar el inicio de sesión general de FINSER PAY. La aprobación se
vincula a una única solicitud mediante la cédula y el IMEI exactos, y la fábrica
de créditos la recibe automáticamente.

La aprobación de enrolamiento no cambia la solicitud a `APROBADA`. La solicitud
permanece en proceso y solo pasa a `APROBADA` cuando el crédito se finaliza.

## Configuración

El despliegue debe definir secretos distintos:

- `IPHONE_ENROLLMENT_ENABLED=true`: habilita el módulo.
- `IPHONE_ENROLLMENT_SESSION_SECRET`: secreto aleatorio de al menos 32 caracteres
  para firmar enlaces de acceso y sesiones temporales. Rotarlo cierra las
  sesiones e invalida los enlaces pendientes, que deberán regenerarse.
- `IPHONE_ENROLLMENT_IDENTITY_PEPPER`: secreto aleatorio estable de al menos 32
  caracteres para las huellas de cédula, IMEI y auditoría. No debe rotarse sin
  una migración explícita de las revisiones existentes.
- `IPHONE_ENROLLMENT_IDENTITY_KEY_VERSION`: identificador corto de la versión del
  pepper, por ejemplo `v1`.
- `IPHONE_ENROLLMENT_PUBLIC_ORIGIN`: origen público canónico del portal, sin
  ruta; en producción debe ser `https://finserpay.com`. Evita depender del
  dominio interno de Railway para las validaciones CSRF y los enlaces emitidos.

No existe un token maestro público permanente.

La API administrativa rechaza la emisión de enlaces con `503` antes de crear
un grant si el módulo está deshabilitado, falta alguno de estos secretos o su
formato no supera la validación. Listar y revocar accesos sigue disponible para
que el administrador pueda cerrar grants existentes durante una contingencia.

## Emisión del acceso

1. Un administrador central FINSER PAY abre
   `/dashboard/integraciones/enrolamiento-iphone`.
2. Registra el nombre y el identificador interno del analista.
3. Elige una vigencia máxima de una, cuatro u ocho horas.
4. Copia el enlace mostrado una sola vez y lo entrega al analista.

El token del enlace usa un nonce aleatorio de 256 bits y una firma HMAC. Se
almacena únicamente como huella y queda consumido al abrirse. El administrador
puede revocar el acceso; cada operación del portal vuelve a comprobar su
vigencia en la base de datos.

## Flujo del analista

1. Abre el enlace temporal. No ingresa usuario ni contraseña.
2. Consulta la cédula y el IMEI de 15 dígitos.
3. El sistema resuelve exactamente una solicitud iPhone activa que tenga una
   evaluación canónica de DataCrédito aprobada.
4. Confirma el checklist y aprueba el enrolamiento.
5. La fábrica del asesor consulta automáticamente la constancia y habilita el
   control de enrolamiento; el asesor no puede marcarlo ni enviarlo en su
   payload.

El portal no muestra puntajes, fotografías, información financiera, teléfonos,
correo ni dirección. Consultarlo no ejecuta una nueva llamada a DataCrédito.

## Controles de integridad

- El token del caso queda ligado al acceso y a la sesión del analista.
- La revisión se guarda una sola vez por solicitud y usa fecha del servidor.
- Un cambio de cédula o IMEI invalida la revisión para el cierre.
- La creación final del crédito consulta la revisión del servidor e ignora
  cualquier bandera enviada por el navegador.
- Las consultas y aprobaciones se limitan por sesión. La activación aplica un
  guard local acotado por la huella de cada token y, cuando el grant realmente
  existe, un límite durable aislado por grant. No existe un cupo compartido que
  un cliente pueda agotar para bloquear los demás enlaces.
- Un token con formato inválido o firma HMAC incorrecta se rechaza antes de
  consultar la base de datos. Un tercero no puede fabricar tokens que alcancen
  storage sin conocer el secreto de sesión del módulo.
- Railway puede activar su WAF en modo de ataque durante una contingencia. Un
  rate limit distribuido adicional sigue siendo recomendable como defensa en
  profundidad, pero la base de datos no depende de él para filtrar tokens
  aleatorios.
- La página y sus API usan `no-store`, no se indexan y no pueden embeberse en un
  `iframe`.
