# FINSER PAY Clientes Android

App Android liviana para abrir el portal de clientes:

```text
https://finserpay.com/clientes
```

## Generar APK de prueba

El APK se genera desde GitHub Actions en el workflow `Android APK Clientes`.

1. En GitHub abre `Actions`.
2. Selecciona `Android APK Clientes`.
3. Ejecuta `Run workflow`.
4. Descarga el artefacto `finserpay-clientes-debug-apk`.

El archivo generado es de prueba (`debug`). Para publicar en Play Store se debe crear una firma de release.

## Generar AAB para Play Store

La publicacion en Google Play usa un Android App Bundle (`.aab`) firmado con una llave de subida. La llave y sus claves no deben guardarse en el repositorio.

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
