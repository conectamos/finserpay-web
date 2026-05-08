import prisma from "@/lib/prisma";

export const DIGITAL_COLLECTION_SEDE_CODE = "RECAUDO_DIGITAL";
export const DIGITAL_COLLECTION_SEDE_NAME = "RECAUDO DIGITAL FINSER PAY";
export const DIGITAL_COLLECTION_CAJA_CONCEPT = "ABONO CREDITO RECAUDO DIGITAL";

export async function ensureDigitalCollectionSede() {
  const byCode = await prisma.sede.findUnique({
    where: { codigo: DIGITAL_COLLECTION_SEDE_CODE },
    select: {
      activa: true,
      codigo: true,
      id: true,
      nombre: true,
    },
  });

  if (byCode) {
    if (
      byCode.nombre !== DIGITAL_COLLECTION_SEDE_NAME ||
      !byCode.activa
    ) {
      return prisma.sede.update({
        where: { id: byCode.id },
        data: {
          activa: true,
          nombre: DIGITAL_COLLECTION_SEDE_NAME,
        },
        select: {
          codigo: true,
          id: true,
          nombre: true,
        },
      });
    }

    return {
      codigo: byCode.codigo,
      id: byCode.id,
      nombre: byCode.nombre,
    };
  }

  const byName = await prisma.sede.findUnique({
    where: { nombre: DIGITAL_COLLECTION_SEDE_NAME },
    select: {
      activa: true,
      codigo: true,
      id: true,
      nombre: true,
    },
  });

  if (byName) {
    if (byName.codigo !== DIGITAL_COLLECTION_SEDE_CODE || !byName.activa) {
      return prisma.sede.update({
        where: { id: byName.id },
        data: {
          activa: true,
          codigo: DIGITAL_COLLECTION_SEDE_CODE,
        },
        select: {
          codigo: true,
          id: true,
          nombre: true,
        },
      });
    }

    return {
      codigo: byName.codigo,
      id: byName.id,
      nombre: byName.nombre,
    };
  }

  try {
    return await prisma.sede.create({
      data: {
        activa: true,
        codigo: DIGITAL_COLLECTION_SEDE_CODE,
        nombre: DIGITAL_COLLECTION_SEDE_NAME,
      },
      select: {
        codigo: true,
        id: true,
        nombre: true,
      },
    });
  } catch (error) {
    const recovered = await prisma.sede.findFirst({
      where: {
        OR: [
          { codigo: DIGITAL_COLLECTION_SEDE_CODE },
          { nombre: DIGITAL_COLLECTION_SEDE_NAME },
        ],
      },
      select: {
        codigo: true,
        id: true,
        nombre: true,
      },
    });

    if (recovered) {
      return recovered;
    }

    throw error;
  }
}
