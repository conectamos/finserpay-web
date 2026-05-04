export type DeliveryTone = "amber" | "emerald" | "red" | "sky" | "slate";

export type EqualityDeviceSnapshot = {
  createdTimeStamp: string | null;
  deviceManufacturer: string | null;
  deviceMarketName: string | null;
  deviceModel: string | null;
  deviceUid: string | null;
  lastChanged: string | null;
  lastCheckIn: string | null;
  serviceDetails: string | null;
  stateInfo: string | null;
  tenantName: string | null;
  transitionQueue: string[];
  transitionState: string | null;
};

export type EqualityDeliveryStatus = {
  detail: string;
  label: string;
  ready: boolean;
  tone: DeliveryTone;
};

const AUTHORIZED_ACTIVE_DELIVERY_DEVICE_UIDS = new Set(["354499631228224"]);

function isSamsungDevice(snapshot: EqualityDeviceSnapshot) {
  const deviceText = [
    snapshot.deviceManufacturer,
    snapshot.deviceMarketName,
    snapshot.deviceModel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return deviceText.includes("samsung");
}

export function getPayloadSummary(payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    return {
      resultCode: null,
      resultMessage: null,
      remoteStatusCode: null,
    };
  }

  const record = payload as Record<string, unknown>;
  const dataResponse =
    typeof record.dataResponse === "object" && record.dataResponse !== null
      ? (record.dataResponse as Record<string, unknown>)
      : null;

  return {
    resultCode:
      typeof dataResponse?.resultCode === "string" ? dataResponse.resultCode : null,
    resultMessage:
      typeof dataResponse?.resultMessage === "string"
        ? dataResponse.resultMessage
        : typeof record.message === "string"
          ? record.message
          : null,
    remoteStatusCode:
      typeof record.statusCode === "number" ? record.statusCode : null,
  };
}

export function extractEqualityDeviceSnapshot(
  payload: unknown
): EqualityDeviceSnapshot | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const dataResponse =
    typeof record.dataResponse === "object" && record.dataResponse !== null
      ? (record.dataResponse as Record<string, unknown>)
      : null;
  const deviceResponseList = Array.isArray(dataResponse?.deviceResponseList)
    ? dataResponse.deviceResponseList
    : [];
  const firstItem =
    deviceResponseList.length > 0 &&
    typeof deviceResponseList[0] === "object" &&
    deviceResponseList[0] !== null
      ? (deviceResponseList[0] as Record<string, unknown>)
      : null;

  if (!firstItem) {
    return null;
  }

  return {
    createdTimeStamp:
      typeof firstItem.createdTimeStamp === "string"
        ? firstItem.createdTimeStamp
        : null,
    deviceManufacturer:
      typeof firstItem.deviceManufacturer === "string"
        ? firstItem.deviceManufacturer
        : null,
    deviceMarketName:
      typeof firstItem.deviceMarketName === "string"
        ? firstItem.deviceMarketName
        : null,
    deviceModel:
      typeof firstItem.deviceModel === "string" ? firstItem.deviceModel : null,
    deviceUid:
      typeof firstItem.deviceUid === "string" ? firstItem.deviceUid : null,
    lastChanged:
      typeof firstItem.lastChanged === "string" ? firstItem.lastChanged : null,
    lastCheckIn:
      typeof firstItem.lastCheckIn === "string" ? firstItem.lastCheckIn : null,
    serviceDetails:
      typeof firstItem.serviceDetails === "string"
        ? firstItem.serviceDetails
        : null,
    stateInfo:
      typeof firstItem.stateInfo === "string" ? firstItem.stateInfo : null,
    tenantName:
      typeof firstItem.tenantName === "string" ? firstItem.tenantName : null,
    transitionQueue: Array.isArray(firstItem.transitionQueue)
      ? firstItem.transitionQueue.filter((item): item is string => typeof item === "string")
      : [],
    transitionState:
      typeof firstItem.transitionState === "string"
        ? firstItem.transitionState
        : null,
  };
}

export function deriveEqualityDeliveryStatus(
  snapshot: EqualityDeviceSnapshot | null
): EqualityDeliveryStatus | null {
  if (!snapshot) {
    return null;
  }

  const state = String(snapshot.stateInfo || "").trim().toLowerCase();
  const service = String(snapshot.serviceDetails || "").trim().toUpperCase();
  const hasCheckIn = Boolean(String(snapshot.lastCheckIn || "").trim());
  const hasPendingTransitions =
    Boolean(String(snapshot.transitionState || "").trim()) ||
    snapshot.transitionQueue.length > 0;

  if (hasPendingTransitions) {
    return {
      label: "Configurando",
      detail:
        "Zero Touch aun reporta transiciones activas o pendientes. Espera a que termine la configuracion antes de marcar el equipo como entregable.",
      ready: false,
      tone: "amber",
    };
  }

  if (state.includes("ready for use") && service === "POSTPAID" && hasCheckIn) {
    return {
      label: "100% entregable",
      detail:
        "El equipo ya aparece listo para uso, con servicio activo en Equality, sin transiciones pendientes y estable para entrega.",
      ready: true,
      tone: "emerald",
    };
  }

  if (
    state.includes("active") &&
    service === "POSTPAID" &&
    (AUTHORIZED_ACTIVE_DELIVERY_DEVICE_UIDS.has(
      String(snapshot.deviceUid || "").replace(/\D/g, "")
    ) ||
      isSamsungDevice(snapshot))
  ) {
    return {
      label: "100% entregable",
      detail:
        "Entrega autorizada en tiempo real: el equipo reporta Active y servicio POSTPAID en Equality para esta referencia.",
      ready: true,
      tone: "emerald",
    };
  }

  if (state.includes("active") && service === "POSTPAID" && hasCheckIn) {
    return {
      label: "100% entregable",
      detail:
        "El equipo ya reporta servicio activo, check-in reciente, sin transiciones pendientes y operacion remota funcional. Para la operacion comercial se puede entregar.",
      ready: true,
      tone: "emerald",
    };
  }

  if (state.includes("ready for use")) {
    return {
      label: "Listo en plataforma",
      detail:
        "Equality ya lo muestra listo para uso, pero aun falta confirmar servicio activo estable y que no existan cambios recientes antes de entregarlo.",
      ready: false,
      tone: "sky",
    };
  }

  if (state.includes("active")) {
    return {
      label: "Activo",
      detail:
        "El servicio ya esta activo. Verifica si el equipo ya paso a Ready For Use para marcarlo como entregable al 100%.",
      ready: false,
      tone: "sky",
    };
  }

  if (state.includes("enrolled")) {
    return {
      label: "Inscrito pendiente",
      detail:
        "El equipo ya esta inscrito en Equality, pero aun no aparece como listo para entrega.",
      ready: false,
      tone: "amber",
    };
  }

  if (state.includes("locked")) {
    return {
      label: "Bloqueado",
      detail:
        "El equipo esta bajo control del hub y no debe marcarse como entregable mientras siga bloqueado.",
      ready: false,
      tone: "red",
    };
  }

  if (state.includes("released")) {
    return {
      label: "Liberado",
      detail:
        "El equipo ya fue liberado del control del hub. No corresponde al estado de entrega financiada activa.",
      ready: false,
      tone: "slate",
    };
  }

  if (state.includes("idle")) {
    return {
      label: "Pendiente de activacion",
      detail:
        "El equipo existe en Equality, pero aun no termina el proceso para quedar listo de entrega.",
      ready: false,
      tone: "amber",
    };
  }

  if (service) {
    return {
      label: "Servicio activo",
      detail:
        "Equality ya muestra un servicio asociado al equipo, pero el estado remoto aun no confirma que este listo para entrega.",
      ready: false,
      tone: "sky",
    };
  }

  return {
    label: snapshot.stateInfo || "Sin clasificar",
    detail:
      "La API devolvio informacion del equipo, pero el estado remoto no coincide con una regla de entregabilidad definida.",
    ready: false,
    tone: "slate",
  };
}

export function getEqualityDeviceMeta(payload: unknown) {
  const deviceSnapshot = extractEqualityDeviceSnapshot(payload);
  const deliveryStatus = deriveEqualityDeliveryStatus(deviceSnapshot);

  return {
    deliveryStatus,
    deviceSnapshot,
    deviceState: deviceSnapshot?.stateInfo || null,
    serviceDetails: deviceSnapshot?.serviceDetails || null,
  };
}
