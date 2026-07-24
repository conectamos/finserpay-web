# FINSER PAY Clientes Android

App Android liviana para abrir el portal de clientes:

```text
https://finserpay.com/clientes
```

Version actual: `1.0.3` (codigo `4`), compilada para Android API 36.

## Generar APK de prueba

El APK se genera desde GitHub Actions en el workflow `Android APK Clientes`.

1. En GitHub abre `Actions`.
2. Selecciona `Android APK Clientes`.
3. Ejecuta `Run workflow`.
4. Descarga el artefacto `finserpay-clientes-debug-apk`.

El artefacto `finserpay-clientes-debug-apk` es de prueba y no se publica en
Google Play.

## Generar AAB para Play Store

La publicacion en Google Play usa un Android App Bundle (`.aab`) firmado con
la misma llave de subida de las versiones anteriores. La llave y sus claves no
deben guardarse en el repositorio.

Secrets requeridos en GitHub:

```text
FINSERPAY_RELEASE_KEYSTORE_BASE64=Contenido Base64 de la llave .jks existente
FINSERPAY_RELEASE_STORE_PASSWORD=Clave del keystore
FINSERPAY_RELEASE_KEY_ALIAS=Alias de la llave
FINSERPAY_RELEASE_KEY_PASSWORD=Clave de la llave
```

En Windows, el contenido Base64 se puede llevar al portapapeles sin modificar
la llave:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\ruta\finserpay-upload.jks")) | Set-Clipboard
```

Cuando los cuatro secrets existen, el workflow genera el artefacto
`finserpay-clientes-play-aab`, que contiene
`finserpay-clientes-1.0.3.aab`.

No se debe crear una llave nueva: Google Play exige conservar la llave de
subida asociada a `com.finserpay.clientes`.

### Compilacion local

Variables requeridas para compilar release:

```text
FINSERPAY_RELEASE_STORE_FILE=Ruta completa del .jks
FINSERPAY_RELEASE_STORE_PASSWORD=Clave del keystore
FINSERPAY_RELEASE_KEY_ALIAS=Alias de la llave
FINSERPAY_RELEASE_KEY_PASSWORD=Clave de la llave
```

Comando:

```powershell
gradle :app:bundleRelease
```

El bundle se genera en:

```text
app/build/outputs/bundle/release/app-release.aab
```

## Notificaciones push

La app queda preparada para Firebase Cloud Messaging.

1. En Firebase registra una app Android con el paquete `com.finserpay.clientes`.
2. Descarga `google-services.json` y guardalo como secret de GitHub `GOOGLE_SERVICES_JSON` para que el workflow lo inserte al compilar. Localmente tambien puedes ubicarlo en `android-client/app/google-services.json`.
3. En Railway configura una de estas opciones:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` con el JSON completo de la cuenta de servicio.
   - O `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` por separado.
4. Genera e instala una APK nueva para que el cliente registre su token FCM.

El backend guarda el token cuando el cliente consulta su cedula en `/clientes` desde la app. El workflow `Recordatorios push clientes` envia avisos diarios de cuotas cercanas, cuotas del dia y mora.
