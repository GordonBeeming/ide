import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  LSPClient,
  languageServerExtensions,
  type Transport,
} from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import {
  isNativeTauri,
  sendLspMessage,
  startLsp,
  type EditorDiagnostic,
} from "./tauri";

interface LspMessageEvent {
  language: string;
  sessionId: string;
  message: string;
}

interface LspLogEvent {
  language: string;
  message: string;
}

interface LspDiagnosticMessage {
  method?: string;
  params?: {
    uri?: string;
    diagnostics?: LspDiagnostic[];
  };
}

interface LspDiagnostic {
  message?: string;
  severity?: number;
  source?: string;
  code?: string | number;
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
}

interface ClientRecord {
  client: LSPClient;
  sessionId: string;
  ready: Promise<void>;
  dispose: () => void;
}

interface ManagedTransport {
  transport: Transport;
  dispose: () => void;
}

const clients = new Map<string, ClientRecord>();
let rootUri = "";
let errorHandler: ((message: string) => void) | undefined;
let statusHandler: (() => void) | undefined;
let diagnosticsHandler:
  | ((filePath: string, diagnostics: EditorDiagnostic[]) => void)
  | undefined;
let lspLogListenerStarted = false;

export function setLspRootUri(uri: string) {
  const nextRootUri = normalizeRootUri(uri);
  if (nextRootUri !== normalizeRootUri(rootUri)) {
    clearLspClientCache();
  }
  rootUri = nextRootUri;
}

export function setLspErrorHandler(handler: (message: string) => void) {
  errorHandler = handler;
  if (!isNativeTauri() || lspLogListenerStarted) return;

  lspLogListenerStarted = true;
  listen<LspLogEvent>("lsp://log", (event) => {
    errorHandler?.(`LSP ${event.payload.language}: ${event.payload.message}`);
    statusHandler?.();
  }).catch((error) => {
    errorHandler?.(`Unable to register LSP log listener: ${String(error)}`);
    lspLogListenerStarted = false;
  });
}

export function setLspStatusHandler(handler: () => void) {
  statusHandler = handler;
}

export function setLspDiagnosticsHandler(
  handler: (filePath: string, diagnostics: EditorDiagnostic[]) => void,
) {
  diagnosticsHandler = handler;
}

export async function lspExtensionsForPath(path: string): Promise<Extension[]> {
  const language = languageForLsp(path);
  if (!language) return [];
  if (!isNativeTauri()) return [];

  const record = await getClient(language);
  await record.ready;
  return [record.client.plugin(workspaceRelativePathToFileUri(path), languageIdForPath(path))];
}

async function getClient(language: string): Promise<ClientRecord> {
  const existing = clients.get(language);
  if (existing) return existing;

  const started = await startLsp(language);
  const managedTransport = await tauriTransport(language, started.sessionId);
  const client = new LSPClient({
    rootUri,
    extensions: languageServerExtensions(),
    timeout: 5000,
    sanitizeHTML: sanitizeHtml,
  }).connect(managedTransport.transport);
  const record = {
    client,
    sessionId: started.sessionId,
    ready: client.initializing.then(() => undefined),
    dispose: managedTransport.dispose,
  };
  clients.set(language, record);
  statusHandler?.();
  return record;
}

function clearLspClientCache() {
  for (const record of clients.values()) {
    record.client.disconnect();
    record.dispose();
  }
  clients.clear();
  statusHandler?.();
}

function normalizeRootUri(uri: string) {
  return uri.replace(/\/$/, "");
}

async function tauriTransport(
  language: string,
  sessionId: string,
): Promise<ManagedTransport> {
  let handlers: Array<(value: string) => void> = [];
  let unlisten: UnlistenFn | undefined;

  unlisten = await listen<LspMessageEvent>("lsp://message", (event) => {
    if (
      event.payload.language === language &&
      event.payload.sessionId === sessionId
    ) {
      handleDiagnosticsMessage(event.payload.message);
      for (const handler of handlers) handler(event.payload.message);
    }
  });

  return {
    transport: {
      send(message: string) {
        sendLspMessage(language, message).catch((error) => {
          errorHandler?.(`LSP send failed for ${language}: ${String(error)}`);
          unlisten?.();
        });
      },
      subscribe(handler: (value: string) => void) {
        handlers.push(handler);
      },
      unsubscribe(handler: (value: string) => void) {
        handlers = handlers.filter((candidate) => candidate !== handler);
      },
    },
    dispose() {
      handlers = [];
      unlisten?.();
      unlisten = undefined;
    },
  };
}

export function __primeLspClientCacheForTest(
  root: string,
  records: Array<{
    language: string;
    disconnect: () => void;
    dispose: () => void;
  }>,
) {
  rootUri = normalizeRootUri(root);
  clients.clear();
  for (const record of records) {
    clients.set(record.language, {
      client: { disconnect: record.disconnect } as LSPClient,
      sessionId: `${record.language}-test`,
      ready: Promise.resolve(),
      dispose: record.dispose,
    });
  }
}

export function __lspClientCacheSizeForTest() {
  return clients.size;
}

export function languageForLsp(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(ts|tsx|js|jsx)$/.test(lower)) return "typescript";
  if (lower.endsWith(".cs")) return "csharp";
  return undefined;
}

export function languageIdForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "typescriptreact";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx")) return "javascriptreact";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".rs")) return "rust";
  return "plaintext";
}

export function workspacePathToFileUri(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-z]:\//i.test(normalized)) {
    const [drive, ...rest] = normalized.split("/");
    return `file:///${drive}${rest.length ? `/${rest.map(encodeURIComponent).join("/")}` : ""}`;
  }

  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

export function workspaceRelativePathToFileUri(path: string, root = rootUri) {
  if (!isSafeWorkspaceRelativePath(path)) {
    throw new Error(`LSP document path must stay inside the current workspace: ${path}`);
  }

  const normalizedRoot = normalizeRootUri(root);
  return `${normalizedRoot}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function handleDiagnosticsMessage(message: string) {
  if (!diagnosticsHandler) return;

  let result: { filePath: string; diagnostics: EditorDiagnostic[] } | undefined;
  try {
    result = diagnosticsFromLspMessage(message, rootUri);
  } catch (error) {
    errorHandler?.(`Unable to parse LSP diagnostics message: ${String(error)}`);
    return;
  }

  if (result) diagnosticsHandler(result.filePath, result.diagnostics);
}

export function diagnosticsFromLspMessage(message: string, root: string) {
  const parsed = JSON.parse(message) as LspDiagnosticMessage;
  if (parsed.method !== "textDocument/publishDiagnostics") return undefined;

  const uri = parsed.params?.uri;
  const filePath = uri ? filePathFromUri(uri, root) : undefined;
  if (!filePath) {
    throw new Error("Received LSP diagnostics for a file outside the current workspace");
  }

  return {
    filePath,
    diagnostics: (parsed.params?.diagnostics ?? []).map((diagnostic) =>
      normalizeDiagnostic(filePath, diagnostic),
    ),
  };
}

function filePathFromUri(uri: string, rootUriValue: string) {
  const root = rootUriValue.replace(/\/$/, "");
  if (!uri.startsWith(`${root}/`)) return undefined;
  const filePath = decodeURIComponent(uri.slice(root.length + 1));
  if (!isSafeWorkspaceRelativePath(filePath)) return undefined;
  return filePath;
}

function isSafeWorkspaceRelativePath(filePath: string) {
  if (!filePath || filePath.startsWith("/") || /^[a-z]:/i.test(filePath)) {
    return false;
  }

  return !filePath
    .split(/[\\/]+/)
    .some((part) => part === "" || part === "." || part === "..");
}

function normalizeDiagnostic(
  filePath: string,
  diagnostic: LspDiagnostic,
): EditorDiagnostic {
  const start = diagnostic.range?.start;
  const end = diagnostic.range?.end;
  return {
    filePath,
    message: diagnostic.message ?? "Language server diagnostic",
    severity: diagnostic.severity,
    source: diagnostic.source,
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    startLine: (start?.line ?? 0) + 1,
    startColumn: (start?.character ?? 0) + 1,
    endLine: (end?.line ?? start?.line ?? 0) + 1,
    endColumn: (end?.character ?? start?.character ?? 0) + 1,
  };
}

export function sanitizeHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content
    .querySelectorAll("script, iframe, object, embed, link, style, base, meta, form, input, button, img, audio, video, source")
    .forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      if (shouldRemoveHtmlAttribute(attribute.name, attribute.value)) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}

function shouldRemoveHtmlAttribute(name: string, value: string) {
  const lowerName = name.toLowerCase();
  if (/^on/i.test(lowerName)) return true;
  if (lowerName === "srcdoc" || lowerName === "style") return true;
  if (["href", "xlink:href", "src", "srcset", "formaction"].includes(lowerName)) {
    return isUnsafeUrl(value);
  }
  return false;
}

function isUnsafeUrl(value: string) {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "").toLowerCase();
  return /^(javascript|data|vbscript|file):/.test(normalized);
}
