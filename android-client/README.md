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
