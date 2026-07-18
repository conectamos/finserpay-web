#!/usr/bin/env node

const TASKS = {
  efecty: {
    label: "Conciliar recaudos Efecty",
    endpoint: "/api/efecty/sync",
    tokenNames: ["EFECTY_SYNC_TOKEN", "MORA_SYNC_TOKEN", "CRON_SECRET"],
    body: {
      dryRun: false,
      limitFiles: 3,
      includePreviousFiles: true,
    },
  },
  mora: {
    label: "Sincronizar mora y bloqueos",
    endpoint: "/api/creditos/sync-mora",
    tokenNames: ["MORA_SYNC_TOKEN", "CRON_SECRET"],
    body: {
      dryRun: false,
    },
  },
};

function formatBogotaDate(date = new Date()) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "America/Bogota",
  }).format(date);
}

function getBaseUrl() {
  const raw =
    process.env.FINSERPAY_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://finserpay.com";

  if (!/^https?:\/\//i.test(raw)) {
    throw new Error("FINSERPAY_BASE_URL debe iniciar con http:// o https://");
  }

  return raw.replace(/\/+$/, "");
}

function getToken(task) {
  for (const name of task.tokenNames) {
    const value = process.env[name]?.trim();
    if (value) {
      return { name, value };
    }
  }

  throw new Error(`Falta configurar una variable: ${task.tokenNames.join(" o ")}`);
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const compact = {};
  const keys = [
    "ok",
    "dryRun",
    "generatedAt",
    "selection",
    "summary",
    "processed",
    "blocked",
    "unblocked",
    "errors",
    "message",
    "detail",
  ];

  for (const key of keys) {
    if (key in payload) {
      compact[key] = payload[key];
    }
  }

  return Object.keys(compact).length > 0 ? compact : payload;
}

async function run() {
  const taskName = process.argv[2];
  const task = TASKS[taskName];

  if (!task) {
    console.error(`Uso: node scripts/railway-cron.mjs <${Object.keys(TASKS).join("|")}>`);
    process.exit(1);
  }

  const baseUrl = getBaseUrl();
  const token = getToken(task);
  const url = `${baseUrl}${task.endpoint}`;

  console.log(`[${formatBogotaDate()}] ${task.label}`);
  console.log(`URL: ${url}`);
  console.log(`Token: ${token.name}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(task.body),
  });

  const text = await response.text();
  let payload = text;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // Keep raw text when the endpoint does not return JSON.
  }

  const summary = summarizePayload(payload);
  console.log(
    JSON.stringify(
      {
        status: response.status,
        ok: response.ok,
        response: summary,
      },
      null,
      2,
    ),
  );

  if (!response.ok || payload?.ok === false) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
