# Cupos diarios de consultas por sede

En **Políticas de crédito → Aliados**, el administrador central conserva el
cupo total del aliado y puede abrir **Distribuir por sedes**. La distribución se
activa expresamente; los aliados existentes continúan con su cupo compartido.

Para activar, primero se guarda un total finito del aliado. Cada sede activa
recibe un entero entre 0 y 10.000; la suma no puede superar ese total. Cero impide
nuevas consultas en esa sede. Una sede nueva queda sin asignación (equivale a
cero cuando la distribución está activa) hasta que el administrador la incluya.

La reserva usa la sede propietaria de la solicitud y el aliado al que pertenece,
incluso al retomarla desde la administración central. Comprueba ambos cupos antes
de enviar la consulta al proveedor. Reutilizar una respuesta vigente no consume
otro cupo. Un fallo local anterior al despacho devuelve las dos reservas una
sola vez; una consulta enviada con resultado ambiguo conserva el consumo.

El consumo se reinicia a medianoche de Bogotá. Cambiar la distribución no borra
las consultas realizadas durante el día. El guardado comprueba la versión
observada de la distribución y deja auditoría con el responsable y el motivo.
Reactivar o trasladar una sede también respeta el total asignado.

El esquema se prepara mediante el predeploy habitual de DataCrédito. Las nuevas
columnas tienen valores compatibles con el modo compartido anterior. Desactivar
la distribución vuelve al control total del aliado sin eliminar su historial.
Las políticas de aprobación y los parámetros generales del simulador son
independientes de estos cupos.
