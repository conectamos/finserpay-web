import "server-only";
import type { AttentionIntegration, AttentionMessage, DaptaConversationSnapshot } from "@/lib/atencion-types";

// Public, documented MCP endpoint. No arbitrary URL or tool name is accepted.
const MCP_ENDPOINT = "https://mcp.dapta.ai/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, "2025-03-26"]);
const READ_TOOLS = new Set(["list_conversations", "get_conversation"]);
const WHATSAPP_CHANNELS = new Set(["meta_whatsapp", "twilio_whatsapp", "aldeamo_whatsapp", "whatsapp_api"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LIST_LIMIT = 25;
const MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 16000;
const HISTORY_PAGES = 3;
type JsonObject = Record<string, unknown>;
type Config = { key: string; workspace: string; agent: string };
type AdapterDependencies = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch };
type SnapshotOptions = { cursor?: string | null; historyCursors?: Readonly<Record<string, string | null>> };
class ExpiredMcpSession extends Error {
  constructor(readonly sessionId: string) { super("MCP session expired"); }
}

export class AttentionDaptaError extends Error {
  constructor(public code: "NOT_CONFIGURED" | "INVALID_CURSOR" | "UNAVAILABLE" | "INVALID_RESPONSE" | "SCOPE_MISMATCH", public status: number, message: string) {
    super(message);
    this.name = "AttentionDaptaError";
  }
}

function invalidResponse(): never {
  throw new AttentionDaptaError("INVALID_RESPONSE", 502, "Dapta devolvió una respuesta no compatible. No se importaron los cambios.");
}
function unavailable(): never {
  throw new AttentionDaptaError("UNAVAILABLE", 502, "No fue posible consultar Dapta. Revisa la configuración o vuelve a intentarlo.");
}
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(value) ? value : null;
}
function date(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 50) return null;
  // MCP reads include PostgreSQL's space separator and microseconds. Always require
  // an explicit zone; Date.parse must never infer the server's local time zone.
  const match = /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?)(Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)$/.exec(value);
  if (!match) return null;
  const calendar = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== match[1]) return null;
  const zone = /^[+-]\d{2}$/.test(match[3]) ? `${match[3]}:00` : match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function phone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !/^(?:whatsapp:)?[+\d ().-]+$/.test(value)) return null;
  let digits = value.replace(/^whatsapp:/, "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^3\d{9}$/.test(digits)) digits = `57${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
function cursor(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) invalidResponse();
  return value;
}
function configuration(env: NodeJS.ProcessEnv): Config | null {
  const key = env.DAPTA_MCP_API_KEY?.trim() ?? "";
  const workspace = env.DAPTA_ATTENTION_WORKSPACE_ID?.trim() ?? "";
  const agent = env.DAPTA_ATTENTION_AGENT_ID?.trim() ?? "";
  return key && key.length <= 4096 && !/[\r\n]/.test(key) && UUID.test(workspace) && UUID.test(agent)
    ? { key, workspace, agent } : null;
}

/** No provider metadata, tool arguments, session state or secret URLs leave this adapter. */
function visibleText(value: unknown, secret: string): string | null {
  if (typeof value !== "string" || value.length > MAX_MESSAGE_LENGTH) return null;
  const result = value
    .split(secret).join("[credencial omitida]")
    .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [credencial omitida]")
    .replace(/([?&](?:x-api-key|api[_-]?key|access[_-]?token|token|secret|password|signature)=)[^\s&#"<>]+/gi, "$1[credencial omitida]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|contraseña)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, "$1[dato omitido]")
    .replace(/\b((?:password|contraseña)\s+(?:es|:|=)\s*[*_"']?)[^\s,;"'*_]+/gi, "$1[dato omitido]")
    .replace(/\b\d{3,10}\b(?=[*_"']?\s+(?:es|son)\s+(?:tu|su|el)\s+(?:otp|pin|c[oó]digo\s+de\s+(?:seguridad|verificaci[oó]n|validaci[oó]n|autenticaci[oó]n|acceso))\b)/gi, "[dato omitido]")
    .replace(/\b((?:otp|pin|cvv|cvc|c[oó]digo\s+de\s+(?:seguridad|verificaci[oó]n|validaci[oó]n|autenticaci[oó]n|acceso))\s*(?:es|:|=)?\s*[*_"']+)[\d -]{3,12}\b/gi, "$1[dato omitido]")
    .replace(/\b((?:otp|pin|cvv|cvc|c[oó]digo(?:\s+de\s+(?:seguridad|verificaci[oó]n|validaci[oó]n|autenticaci[oó]n|acceso))?)(?:\s+del\s+contrato)?\s*(?:es|:|=)?\s*["']?)[\d -]{3,12}\b/gi, "$1[dato omitido]")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, "[número sensible omitido]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
  // Redaction labels can lengthen a message, so enforce storage's limit again.
  return result && result.length <= MAX_MESSAGE_LENGTH ? result : null;
}

async function readRpcResponse(response: Response, requestId: number, signal: AbortSignal): Promise<JsonObject> {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  if (contentType !== "application/json" && contentType !== "text/event-stream") invalidResponse();
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_RESPONSE_BYTES || !response.body) invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let pending = "";
  const parse = (raw: string): JsonObject | null => {
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { invalidResponse(); }
    const message = object(decoded);
    if (!message || message.jsonrpc !== "2.0") invalidResponse();
    // Do not service server requests, sampling or notifications. We advertise no capabilities.
    if (message.id !== requestId || typeof message.method === "string") return null;
    if (message.error) unavailable();
    return object(message.result) ?? invalidResponse();
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) unavailable();
      const part = await reader.read();
      bytes += part.value?.byteLength ?? 0;
      if (bytes > MAX_RESPONSE_BYTES) invalidResponse();
      pending += decoder.decode(part.value, { stream: !part.done });
      if (contentType === "text/event-stream") {
        // SSE lines may be split across chunks; normalize only after a complete block arrives.
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(pending)) !== null) {
          const block = pending.slice(0, separator.index);
          pending = pending.slice(separator.index + separator[0].length);
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) { const result = parse(data); if (result) return result; }
        }
      }
      if (part.done) {
        if (contentType === "application/json") return parse(pending) ?? invalidResponse();
        invalidResponse();
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}

function toolPayload(result: JsonObject): JsonObject {
  if (result.isError === true) unavailable();
  let payload = object(result.structuredContent);
  if (!payload && Array.isArray(result.content)) {
    for (const item of result.content) {
      const block = object(item);
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      try { const candidate = object(JSON.parse(block.text)); if (candidate) { payload = candidate; break; } } catch { /* workspace label */ }
    }
  }
  if (!payload) invalidResponse();
  if (payload.success === false || payload.error) unavailable();
  return payload;
}

function mcpClient(config: Config, transport: typeof fetch, deadline: number) {
  let sequence = 0;
  let session: string | null = null;
  let protocol = PROTOCOL_VERSION;
  let renewal: Promise<void> | null = null;
  async function send(method: string, params?: JsonObject, notification = false): Promise<JsonObject> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) unavailable();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const id = notification ? undefined : ++sequence;
    const requestSession = session;
    const run = async () => {
      const response = await transport(MCP_ENDPOINT, {
        method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "x-api-key": config.key, ...(requestSession ? { "Mcp-Session-Id": requestSession } : {}),
          ...(method === "initialize" ? {} : { "MCP-Protocol-Version": protocol }) },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404 && requestSession) throw new ExpiredMcpSession(requestSession);
        unavailable();
      }
      if (notification) {
        await response.body?.cancel().catch(() => {});
        if (response.status !== 202 && response.status !== 204) invalidResponse();
        return {};
      }
      if (method === "initialize") {
        const supplied = response.headers.get("Mcp-Session-Id");
        if (supplied && !/^[\x21-\x7e]{1,1024}$/.test(supplied)) invalidResponse();
        session = supplied;
      }
      return readRpcResponse(response, id!, controller.signal);
    };
    try {
      return await Promise.race([run(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new AttentionDaptaError("UNAVAILABLE", 504, "Dapta tardó demasiado en responder. Vuelve a intentarlo."));
        }, Math.min(8000, remaining));
      })]);
    } catch (error) {
      if (error instanceof AttentionDaptaError || error instanceof ExpiredMcpSession) throw error;
      return unavailable();
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async function initialize() {
    session = null;
    try {
      const result = await send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "finserpay-attention-reader", version: "1.0.0" } });
      if (typeof result.protocolVersion !== "string" || !SUPPORTED_PROTOCOLS.has(result.protocolVersion) || !object(object(result.capabilities)?.tools)) invalidResponse();
      protocol = result.protocolVersion;
      await send("notifications/initialized", undefined, true);
    } catch (error) {
      if (error instanceof ExpiredMcpSession) unavailable();
      throw error;
    }
  }
  return {
    initialize,
    async call(name: "list_conversations" | "get_conversation", args: JsonObject) {
      if (!READ_TOOLS.has(name)) invalidResponse();
      // API keys already bind a workspace. The workspace_id argument belongs to login-mode tools.
      try { return toolPayload(await send("tools/call", { name, arguments: args })); } catch (error) {
        if (!(error instanceof ExpiredMcpSession)) throw error;
        if (!renewal && session === error.sessionId) renewal = initialize().finally(() => { renewal = null; });
        if (renewal) await renewal;
        try { return toolPayload(await send("tools/call", { name, arguments: args })); } catch (retryError) {
          if (retryError instanceof ExpiredMcpSession) unavailable();
          throw retryError;
        }
      }
    },
  };
}

function validateWorkspace(payload: JsonObject, config: Config) {
  if (payload.workspace_id !== config.workspace) {
    throw new AttentionDaptaError("SCOPE_MISMATCH", 502, "La respuesta de Dapta no pertenece al espacio configurado. No se importaron los cambios.");
  }
}
function conversationIdentity(row: JsonObject | null, config: Config) {
  if (!row || row.text_agent_id !== config.agent || !WHATSAPP_CHANNELS.has(String(row.channel_type))) return null;
  const id = identifier(row.id);
  const normalizedPhone = phone(row.channel_identifier);
  // Meta also supplies opaque WhatsApp identifiers. Preserve the conversation
  // without ever interpreting that identifier as a customer's phone number.
  const opaqueMeta = row.channel_type === "meta_whatsapp" && typeof row.channel_identifier === "string"
    && /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(row.channel_identifier);
  return id && (normalizedPhone || opaqueMeta)
    ? { id, phone: normalizedPhone, channel: row.channel_type, providerIdentity: row.channel_identifier } : null;
}

export function createDaptaAttentionAdapter(dependencies: AdapterDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const transport = dependencies.fetch ?? globalThis.fetch;
  return {
    attentionIntegrationStatus(): AttentionIntegration {
      const configured = configuration(env) !== null;
      return { configured, canSync: configured, canSend: false, canHandoff: false,
        status: configured ? "read_only" : "not_configured",
        message: configured
          ? "Consulta de Dapta configurada. Respuestas y traspaso de la IA se gestionan en Dapta; esta bandeja no envía mensajes."
          : "Falta configurar el acceso de lectura a Dapta. No hay sincronización ni envío de mensajes activos." };
    },
    async fetchDaptaConversationSnapshots(options: SnapshotOptions = {}): Promise<{ snapshots: DaptaConversationSnapshot[]; nextCursor: string | null; skipped: number }> {
      const configured = configuration(env);
      if (!configured) throw new AttentionDaptaError("NOT_CONFIGURED", 503, "Configura las credenciales de lectura, el espacio y el agente de Dapta en el servidor.");
      const config: Config = configured;
      let requestedCursor: string | null;
      try { requestedCursor = cursor(options.cursor); } catch {
        throw new AttentionDaptaError("INVALID_CURSOR", 400, "El cursor de sincronización no es válido.");
      }
      const client = mcpClient(config, transport, Date.now() + 55000);
      await client.initialize();
      const list = await client.call("list_conversations", { agent_id: config.agent,
        channel_type: [...WHATSAPP_CHANNELS], limit: LIST_LIMIT, window_days: 365,
        ...(requestedCursor ? { cursor: requestedCursor } : {}) });
      validateWorkspace(list, config);
      if (!Array.isArray(list.conversations) || list.conversations.length > LIST_LIMIT) invalidResponse();
      const nextCursor = cursor(list.next_cursor);
      if (nextCursor && nextCursor === requestedCursor) invalidResponse();
      const snapshots: DaptaConversationSnapshot[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      let index = 0;
      const rows = list.conversations;
      async function worker() {
        while (index < rows.length) {
          const row = object(rows[index++]);
          const identity = conversationIdentity(row, config);
          if (!identity || seen.has(identity.id)) { skipped++; continue; }
          seen.add(identity.id);
          const messages = new Map<string, AttentionMessage>();
          let pageCursor: string | null = null;
          if (options.historyCursors && Object.prototype.hasOwnProperty.call(options.historyCursors, identity.id)) {
            try { pageCursor = cursor(options.historyCursors[identity.id]); } catch {
              throw new AttentionDaptaError("INVALID_CURSOR", 400, "El cursor de historial no es válido. Revisa el punto de sincronización guardado.");
            }
          }
          let historyCursor: string | null = pageCursor;
          const cursors = new Set<string>(pageCursor ? [pageCursor] : []);
          let historyTruncated = false;
          let detailRow: JsonObject | null = null;
          for (let page = 0; page < HISTORY_PAGES; page++) {
            const inputCursor: string | null = pageCursor;
            const detail = await client.call("get_conversation", { agent_id: config.agent, conversation_id: identity.id,
              include_messages: true, include_state: false, include_tool_payloads: false, fresh: false,
              messages_limit: MESSAGE_LIMIT, ...(pageCursor ? { messages_cursor: pageCursor } : {}) });
            validateWorkspace(detail, config);
            detailRow = object(detail.conversation);
            const actual = conversationIdentity(detailRow, config);
            if (!actual || actual.id !== identity.id || actual.phone !== identity.phone || actual.channel !== identity.channel
              || (identity.phone === null && actual.providerIdentity !== identity.providerIdentity)) {
              throw new AttentionDaptaError("SCOPE_MISMATCH", 502, "Dapta devolvió una conversación diferente a la solicitada. No se importaron los cambios.");
            }
            if (!Array.isArray(detail.messages) || detail.messages.length > MESSAGE_LIMIT) invalidResponse();
            for (const entry of detail.messages) {
              const message = object(entry);
              if (!message || !["lead", "agent", "followup"].includes(String(message.kind))) continue;
              // The public UI model has no delivery-state field: do not portray a failed/pending send as a reply.
              if (message.direction === "outbound" && !["sent", "delivered", "read"].includes(String(message.status))) { historyTruncated = true; continue; }
              const id = identifier(message.id);
              const sentAt = date(message.created_at);
              const attachments: Record<string, string> = { image: "[Imagen de WhatsApp · consulta el adjunto en WhatsApp]",
                audio: "[Audio de WhatsApp · consulta el adjunto en WhatsApp]", video: "[Video de WhatsApp · consulta el adjunto en WhatsApp]",
                document: "[Documento de WhatsApp · consulta el adjunto en WhatsApp]", sticker: "[Sticker de WhatsApp]" };
              const contentType = String(message.content_type);
              const text = contentType === "text" || contentType === "template"
                ? visibleText(message.content, config.key)
                : Object.prototype.hasOwnProperty.call(attachments, contentType) ? attachments[contentType] : null;
              if (!id || !sentAt || !text || !["inbound", "outbound"].includes(String(message.direction))) { historyTruncated = true; continue; }
              messages.set(id, { id, sentAt, text, direction: message.direction as "inbound" | "outbound", author: null });
            }
            pageCursor = cursor(detail.messages_next_cursor);
            // MCP returns oldest-first. Advance bounded batches; at EOF keep the input
            // of the last page so future syncs re-read its tail and find newer messages.
            // Persist this checkpoint only in the transaction that stores the messages.
            historyCursor = pageCursor ?? inputCursor;
            if (!pageCursor) break;
            if (cursors.has(pageCursor)) { historyTruncated = true; break; }
            cursors.add(pageCursor);
          }
          snapshots.push({ externalId: identity.id, phone: identity.phone, name: null,
            lastContactAt: date(detailRow?.last_message_at) ?? date(row?.last_message_at),
            // A disabled model does not prove a human has accepted the handover.
            mode: detailRow?.llmdisabled === false ? "ai" : "unknown",
            messages: [...messages.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id)),
            historyTruncated: historyTruncated || pageCursor !== null, historyCursor });
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => worker()));
      snapshots.sort((a, b) => (b.lastContactAt ?? "").localeCompare(a.lastContactAt ?? "") || a.externalId.localeCompare(b.externalId));
      return { snapshots, nextCursor, skipped };
    },
  };
}

export function attentionIntegrationStatus(): AttentionIntegration {
  return createDaptaAttentionAdapter().attentionIntegrationStatus();
}
export function fetchDaptaConversationSnapshots(options: SnapshotOptions = {}) {
  return createDaptaAttentionAdapter().fetchDaptaConversationSnapshots(options);
}
