BEGIN;

INSERT INTO "Rol" ("nombre", "descripcion", "createdAt", "updatedAt")
VALUES
  ('ADMIN', 'Administrador del sistema', NOW(), NOW()),
  ('USUARIO', 'Usuario operativo por sede', NOW(), NOW())
ON CONFLICT ("nombre") DO UPDATE
SET
  "descripcion" = EXCLUDED."descripcion",
  "updatedAt" = NOW();

INSERT INTO "Sede" ("nombre", "codigo", "activa", "clavePanelFinancieroHash", "createdAt", "updatedAt")
VALUES
  ('BODEGA PRINCIPAL', 'BODEGA-PRINCIPAL', true, NULL, NOW(), NOW()),
  ('SEDE 1', 'SEDE-1', true, NULL, NOW(), NOW()),
  ('SEDE 2', 'SEDE-2', true, NULL, NOW(), NOW()),
  ('SEDE 3', 'SEDE-3', true, NULL, NOW(), NOW()),
  ('SEDE 4', 'SEDE-4', true, NULL, NOW(), NOW()),
  ('SEDE 5', 'SEDE-5', true, NULL, NOW(), NOW()),
  ('SEDE 6', 'SEDE-6', true, NULL, NOW(), NOW()),
  ('SEDE 7', 'SEDE-7', true, NULL, NOW(), NOW()),
  ('ONLINE', 'ONLINE', true, NULL, NOW(), NOW()),
  ('TROPAS', 'TROPAS', true, NULL, NOW(), NOW()),
  ('Stand PuntoNet', 'STAND-PUNTONET', true, NULL, NOW(), NOW()),
  ('Stand Monky', 'STAND-MONKY', true, NULL, NOW(), NOW()),
  ('Stand Solutions', 'STAND-SOLUTIONS', true, NULL, NOW(), NOW())
ON CONFLICT ("nombre") DO UPDATE
SET
  "codigo" = EXCLUDED."codigo",
  "activa" = EXCLUDED."activa",
  "updatedAt" = NOW();

INSERT INTO "Usuario" ("nombre", "usuario", "claveHash", "activo", "rolId", "sedeId", "createdAt", "updatedAt")
SELECT
  data.nombre,
  data.usuario,
  data.clave,
  true,
  rol.id,
  sede.id,
  NOW(),
  NOW()
FROM (
  VALUES
    ('Administrador', 'admin', '123456', 'ADMIN', 'BODEGA PRINCIPAL'),
    ('Usuario Sede 1', 'sede1', '123456', 'USUARIO', 'SEDE 1'),
    ('Usuario Sede 2', 'sede2', '123456', 'USUARIO', 'SEDE 2'),
    ('Usuario Sede 3', 'sede3', '123456', 'USUARIO', 'SEDE 3'),
    ('Usuario Sede 4', 'sede4', '123456', 'USUARIO', 'SEDE 4'),
    ('Usuario Sede 5', 'sede5', '123456', 'USUARIO', 'SEDE 5'),
    ('Usuario Sede 6', 'sede6', '123456', 'USUARIO', 'SEDE 6'),
    ('Usuario Sede 7', 'sede7', '123456', 'USUARIO', 'SEDE 7'),
    ('Usuario Online', 'online', '123456', 'USUARIO', 'ONLINE'),
    ('Usuario Tropas', 'tropas', '123456', 'USUARIO', 'TROPAS'),
    ('Usuario Stand PuntoNet', 'standpuntonet', '123456', 'USUARIO', 'Stand PuntoNet'),
    ('Usuario Stand Monky', 'standmonky', '123456', 'USUARIO', 'Stand Monky'),
    ('Usuario Stand Solutions', 'standsolutions', '123456', 'USUARIO', 'Stand Solutions')
) AS data(nombre, usuario, clave, rol_nombre, sede_nombre)
JOIN "Rol" rol
  ON rol."nombre" = data.rol_nombre
JOIN "Sede" sede
  ON sede."nombre" = data.sede_nombre
ON CONFLICT ("usuario") DO UPDATE
SET
  "nombre" = EXCLUDED."nombre",
  "claveHash" = EXCLUDED."claveHash",
  "activo" = EXCLUDED."activo",
  "rolId" = EXCLUDED."rolId",
  "sedeId" = EXCLUDED."sedeId",
  "updatedAt" = NOW();

COMMIT;
