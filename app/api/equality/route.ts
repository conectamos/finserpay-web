import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
} from "@/lib/equality-device-meta";
import { isAdminRole } from "@/lib/roles";
import {
  activateEqualityFinancingService,
  getEqualityProbeDeviceUid,
  isEqualityApiError,
  isEqualityConfigured,
  lockEqualityDevice,
  normalizeEqualityDeviceUid,
  notifyEqualityDevice,
  queryEqualityDevices,
  releaseEqualityDevice,
  sendEqualityLockMessage,
  unlockEqualityDevice,
  uploadEqualityInventoryDevice,
} from "@/lib/equality-zero-touch";

type EqualityAction =
  | "activate"
  | "enroll"
  | "lock"
  | "lock-message"
  | "notify"
  | "query"
  | "release"
  | "unlock"
  | "upload";

function isBusinessStatus(status: number) {
  return [400, 404, 409, 422].includes(status);
}

async function runBusinessSafe<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (isEqualityApiError(error) && isBusinessStatus(error.status)) {
      return error.payload as T;
    }

    throw error;
  }
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    const admin = isAdminRole(user?.rolNombre);

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const probe = searchParams.get("probe") === "1";
    const requestedDeviceUid = normalizeEqualityDeviceUid(
      searchParams.get("deviceUid") || searchParams.get("imei") || ""
    );
    const deviceUid = probe ? getEqualityProbeDeviceUid() : requestedDeviceUid;

    if (!isEqualityConfigured()) {
      return NextResponse.json({
        configured: false,
        canManage: admin,
        deviceUid,
        probe,
        response: null,
        resultCode: null,
        resultMessage: null,
        remoteStatusCode: null,
        deliveryStatus: null,
        deviceSnapshot: null,
        deviceState: null,
        serviceDetails: null,
      });
    }

    if (!deviceUid) {
      return NextResponse.json({
        configured: true,
        canManage: admin,
        deviceUid,
        probe,
        response: null,
        resultCode: null,
        resultMessage: "Ingresa un deviceUid para consultar Equality Zero Touch",
        remoteStatusCode: null,
        deliveryStatus: null,
        deviceSnapshot: null,
        deviceState: null,
        serviceDetails: null,
      });
    }

    const response = await queryEqualityDevices(deviceUid);
    const summary = getPayloadSummary(response);
    const deviceMeta = getEqualityDeviceMeta(response);

    return NextResponse.json({
      configured: true,
      canManage: admin,
      deviceUid,
      probe,
      response,
      ...summary,
      ...deviceMeta,
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO EQUALITY ZERO TOUCH:", error);

    if (isEqualityApiError(error)) {
      if (isBusinessStatus(error.status)) {
        const { searchParams } = new URL(req.url);
        const probe = searchParams.get("probe") === "1";
        const requestedDeviceUid = normalizeEqualityDeviceUid(
          searchParams.get("deviceUid") || searchParams.get("imei") || ""
        );
        const deviceUid = probe ? getEqualityProbeDeviceUid() : requestedDeviceUid;

        return NextResponse.json({
          configured: true,
          canManage: true,
          deviceUid,
          probe,
          response: error.payload,
          ...getPayloadSummary(error.payload),
          ...getEqualityDeviceMeta(error.payload),
        });
      }

      return NextResponse.json(
        {
          error: error.message,
          remoteStatus: error.status,
          remotePayload: error.payload,
        },
        { status: error.status >= 500 ? 502 : error.status }
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Error consultando Equality Zero Touch",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let action: EqualityAction = "query";
  let deviceUid = "";

  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);

    if (!isEqualityConfigured()) {
      return NextResponse.json(
        {
          error:
            "Configura TRUSTONIC_API_KEY o EQUALITY_HBM_ACCESS_TOKEN para usar Zero Touch",
        },
        { status: 503 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    action = String(body.action || "").trim().toLowerCase() as EqualityAction;
    deviceUid = normalizeEqualityDeviceUid(body.deviceUid);
    const message = String(body.message || "").trim();
    const title = String(body.title || "").trim();

    if (!deviceUid) {
      return NextResponse.json(
        { error: "Debes indicar el deviceUid" },
        { status: 400 }
      );
    }

    if (!admin && !["query", "enroll"].includes(action)) {
      return NextResponse.json(
        { error: "Tu rol solo puede consultar e inscribir equipos" },
        { status: 403 }
      );
    }

    let response;

    switch (action) {
      case "query":
        response = await queryEqualityDevices(deviceUid);
        break;
      case "upload":
        response = await uploadEqualityInventoryDevice(deviceUid);
        break;
      case "activate":
        response = await activateEqualityFinancingService(deviceUid);
        break;
      case "enroll": {
        const upload = await runBusinessSafe(() =>
          uploadEqualityInventoryDevice(deviceUid)
        );
        const activate = await runBusinessSafe(() =>
          activateEqualityFinancingService(deviceUid)
        );

        response = {
          upload,
          activate,
        };
        break;
      }
      case "lock":
        response = await lockEqualityDevice(deviceUid, {
          lockMsgTitle: title || "Telefono bloqueado",
          lockMsgContent: message || "Equipo bloqueado por falta de pago.",
        });
        break;
      case "unlock":
        response = await unlockEqualityDevice(deviceUid);
        break;
      case "release":
        response = await releaseEqualityDevice(deviceUid, message || "End of contract");
        break;
      case "notify":
        if (!message && !title) {
          return NextResponse.json(
            { error: "Debes indicar el mensaje de notificacion" },
            { status: 400 }
          );
        }

        response = await notifyEqualityDevice(deviceUid, {
          notificationTitle: title || "Proximo pago",
          notificationContent: message || "Se aproxima tu fecha de pago",
        });
        break;
      case "lock-message":
        if (!message && !title) {
          return NextResponse.json(
            { error: "Debes indicar el mensaje de bloqueo" },
            { status: 400 }
          );
        }

        response = await sendEqualityLockMessage(deviceUid, {
          messageTitle: title || "Tienes un pago vencido",
          messageContent: message || "Desbloquea tu equipo haz tu pago.",
        });
        break;
      default:
        return NextResponse.json({ error: "Accion no valida" }, { status: 400 });
    }

    let query = null;

    if (action !== "query") {
      try {
        query = await queryEqualityDevices(deviceUid);
      } catch {
        query = null;
      }
    }

    const summarySource =
      action === "enroll" && query
        ? query
        : action === "enroll" &&
            typeof response === "object" &&
            response !== null &&
            "activate" in response
          ? (response as { activate: unknown }).activate
          : response;

    return NextResponse.json({
      ok: true,
      action,
      deviceUid,
      response,
      query,
      ...getPayloadSummary(summarySource),
      ...getEqualityDeviceMeta(query || summarySource),
    });
  } catch (error) {
    console.error("ERROR EJECUTANDO EQUALITY ZERO TOUCH:", error);

    if (isEqualityApiError(error)) {
      if (isBusinessStatus(error.status)) {
        return NextResponse.json({
          ok: false,
          action,
          deviceUid,
          response: error.payload,
          query: null,
          ...getPayloadSummary(error.payload),
          ...getEqualityDeviceMeta(error.payload),
        });
      }

      return NextResponse.json(
        {
          error: error.message,
          remoteStatus: error.status,
          remotePayload: error.payload,
        },
        { status: error.status >= 500 ? 502 : error.status }
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Error ejecutando accion en Equality Zero Touch",
      },
      { status: 500 }
    );
  }
}
