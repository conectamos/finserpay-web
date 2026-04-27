# Publicacion de Conectamos en Railway

Esta guia esta pensada para alguien que no sabe de servidores y quiere publicar la app de la forma mas simple posible.

## Lo que vas a usar

- Railway para subir la aplicacion
- PostgreSQL dentro de Railway
- Un dominio propio opcional

## Antes de empezar

Necesitas:

- una cuenta en GitHub
- una cuenta en Railway
- este proyecto subido a un repositorio privado o publico de GitHub

## Variables de entorno obligatorias

En Railway debes crear estas variables:

- `DATABASE_URL`
- `SESSION_SECRET`
- `EQUALITY_HBM_ACCESS_TOKEN`
- `EQUALITY_HBM_BASE_URL`
- `WOMPI_PUBLIC_KEY`
- `WOMPI_INTEGRITY_SECRET`
- `WOMPI_EVENTS_SECRET`
- `WOMPI_LEGACY_WEBHOOK_URL`
- `NEXT_PUBLIC_APP_URL`

### Ejemplo de `SESSION_SECRET`

Usa una cadena larga y dificil de adivinar, por ejemplo un texto de 32 a 64 caracteres.

## Paso 1. Subir el proyecto a GitHub

Si todavia no lo tienes en GitHub:

1. Crea un repositorio nuevo
2. Sube la carpeta `C:\finserpay-app`
3. Confirma que en GitHub se vea el codigo del proyecto

## Paso 2. Crear el proyecto en Railway

1. Entra a Railway
2. Pulsa `New Project`
3. Elige `Deploy from GitHub repo`
4. Selecciona tu repositorio

## Paso 3. Crear la base de datos

1. Dentro del proyecto en Railway, pulsa `New`
2. Elige `Database`
3. Elige `PostgreSQL`
4. Railway generara una base nueva

## Paso 4. Conectar la app con la base de datos

1. En el servicio de PostgreSQL, copia la variable `DATABASE_URL`
2. En el servicio de la app, abre `Variables`
3. Agrega:
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `EQUALITY_HBM_ACCESS_TOKEN`
   - `EQUALITY_HBM_BASE_URL`
   - `WOMPI_PUBLIC_KEY`
   - `WOMPI_INTEGRITY_SECRET`
   - `WOMPI_EVENTS_SECRET`
   - `WOMPI_LEGACY_WEBHOOK_URL`
   - `NEXT_PUBLIC_APP_URL`

Para Wompi, `NEXT_PUBLIC_APP_URL` debe ser el dominio publico de Railway o tu dominio propio, por ejemplo `https://finserpay-web.up.railway.app`.

Si esta app debe convivir con la plataforma anterior, configura tambien:

```bash
WOMPI_LEGACY_WEBHOOK_URL=https://kaiowa.app/APIS/API_PASARELA_ABONOS_CREDITO/services/transactions/registrar_response_wompi
```

En el panel de Wompi configura una sola URL de eventos apuntando al router:

```bash
https://TU-DOMINIO/api/wompi/webhook-router
```

Ese router procesa en Finserpay las referencias nuevas que empiezan por `FP-` y reenvia a la plataforma anterior las demas transacciones. La llave privada de Wompi no se usa en el checkout publico ni debe guardarse en el repositorio. `WOMPI_INTEGRITY_SECRET` es la llave/secreto de integridad del checkout y `WOMPI_EVENTS_SECRET` es el secreto de eventos/webhook; son valores distintos en el panel de Wompi.

## Paso 5. Comandos de build y arranque

Railway normalmente detecta Node solo, pero si te pide comandos usa estos:

### Build Command

```bash
npm install && npm run prisma:generate && npm run build
```

### Start Command

```bash
npm run start:standalone
```

## Paso 6. Crear tablas en produccion

Antes de usar la app por primera vez, y despues de cambios que agreguen tablas como pagos Wompi, en Railway abre una terminal del servicio de la app y ejecuta:

```bash
npm run db:push
```

Luego, si hace falta, ejecuta tambien:

```bash
npm run prisma:generate
```

## Paso 7. Crear o revisar el usuario admin

Cuando la base ya este conectada:

- verifica que exista tu usuario admin
- confirma que puedes iniciar sesion
- prueba login, fabrica de creditos, dashboard e Equality Zero Touch

## Paso 8. Poner dominio

Puedes usar el dominio gratis de Railway o conectar uno propio:

1. Entra al servicio de la app
2. Abre `Settings` o `Networking`
3. Agrega un dominio personalizado
4. Railway te dira que registros DNS crear
5. En tu proveedor de dominio, pega esos DNS

## Paso 9. Despues de publicar

Cada vez que hagas cambios:

1. pruebas localmente
2. subes cambios a GitHub
3. Railway redeploya solo
4. si cambias la base, ejecutas:

```bash
npm run db:push
```

## Recomendacion importante

Antes de abrir la app a todas las sedes:

- prueba con 1 o 2 sedes reales
- confirma login, generacion de creditos, inscripcion y validacion de entregabilidad
- haz respaldo de la base de datos
- define `SESSION_SECRET` antes de publicar
- si el token de Equality Zero Touch ha sido compartido o mostrado, regeneralo

## Enlaces oficiales

- Next.js self-hosting: https://nextjs.org/docs/app/guides/self-hosting
- Railway docs: https://docs.railway.com
- Prisma deploy: https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate
