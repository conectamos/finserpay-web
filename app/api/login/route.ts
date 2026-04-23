import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword, isPasswordHash, verifyPassword } from "@/lib/password";
import {
  SELLER_SESSION_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/session";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const usuario = String(body.usuario ?? "").trim();
    const clave = String(body.clave ?? "");

    if (!usuario || !clave) {
      return NextResponse.json(
        { error: "Usuario y clave son obligatorios" },
        { status: 400 }
      );
    }

    const user = await prisma.usuario.findUnique({
      where: { usuario },
      select: {
        id: true,
        nombre: true,
        usuario: true,
        claveHash: true,
        rol: true,
        sedeId: true,
        activo: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Credenciales inválidas" },
        { status: 401 }
      );
    }

    if (!user.activo) {
      return NextResponse.json(
        { error: "Usuario inactivo" },
        { status: 401 }
      );
    }

    if (!verifyPassword(clave, user.claveHash)) {
      return NextResponse.json(
        { error: "Credenciales inválidas" },
        { status: 401 }
      );
    }

    if (!isPasswordHash(user.claveHash)) {
      await prisma.usuario.update({
        where: { id: user.id },
        data: {
          claveHash: hashPassword(clave),
        },
      });
    }

    const response = NextResponse.json({
      mensaje: "Login correcto",
      usuario: {
        id: user.id,
        nombre: user.nombre,
        usuario: user.usuario,
        rol: user.rol,
        sedeId: user.sedeId,
      },
    });

    response.cookies.set(
      SESSION_COOKIE_NAME,
      createSessionToken(user.id),
      getSessionCookieOptions()
    );
    response.cookies.set(SELLER_SESSION_COOKIE_NAME, "", {
      ...getSessionCookieOptions(),
      expires: new Date(0),
      maxAge: 0,
    });
    response.cookies.delete("userId");

    return response;
  } catch (error) {
    console.error("ERROR LOGIN API:", error);
    return NextResponse.json(
      { error: "Error al conectar con el servidor" },
      { status: 500 }
    );
  }
}
