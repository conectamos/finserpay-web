import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const { imei } = await req.json();

    const item = await prisma.inventarioPrincipal.findUnique({
      where: { imei },
      select: {
        referencia: true,
        color: true,
        costo: true,
      },
    });

    if (!item) {
      return NextResponse.json({}, { status: 200 });
    }

    return NextResponse.json(item);

  } catch {
    return NextResponse.json({}, { status: 500 });
  }
}
