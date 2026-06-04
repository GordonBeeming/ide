import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  LSPClient,
  languageServerExtensions,
  type Transport,
} from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { isNativeTauri, sendLspMessage, startLsp } from "./tauri";

interface LspMessageEvent {
  language: string;
  sessionId: string;
  message: string;
}

interface ClientRecord {
  client: LSPClient;
  sessionId: string;
  ready: Promise<void>;
}

const clients = new Map<string, ClientRecord>();
let rootUri = "";
let errorHandler: ((message: string) => void) | undefined;

export function setLspRootUri(uri: string) {
  rootUri = uri;
}

export function setLspErrorHandler(handler: (message: string) => void) {
  errorHandler = handler;
}

export async function lspExtensionsForPath(path: string): Promise<Extension[]> {
  const language = languageForLsp(path);
  if (!language) return [];
  if (!isNativeTauri()) return [];

  const record = await getClient(language);
  await record.ready;
  return [record.client.plugin(fileUriForPath(path), languageIdForLsp(language))];
}

async function getClient(language: string): Promise<ClientRecord> {
  const existing = clients.get(language);
  if (existing) return existing;

  const started = await startLsp(language);
  const transport = await tauriTransport(language, started.sessionId);
  const client = new LSPClient({
    rootUri,
    extensions: languageServerExtensions(),
    timeout: 5000,
    sanitizeHTML: sanitizeHtml,
  }).connect(transport);
  const record = {
    client,
    sessionId: started.sessionId,
    ready: client.initializing.then(() => undefined),
  };
  clients.set(language, record);
  return record;
}

async function tauriTransport(language: string, sessionId: string): Promise<Transport> {
  let handlers: Array<(value: string) => void> = [];
  let unlisten: UnlistenFn | undefined;

  unlisten = await listen<LspMessageEvent>("lsp://message", (event) => {
    if (
      event.payload.language === language &&
      event.payload.sessionId === sessionId
    ) {
      for (const handler of handlers) handler(event.payload.message);
    }
  });

  return {
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
  };
}

export function languageForLsp(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(ts|tsx|js|jsx)$/.test(lower)) return "typescript";
  if (lower.endsWith(".cs")) return "csharp";
  return undefined;
}

function languageIdForLsp(language: string) {
  if (language === "typescript") return "typescript";
  if (language === "csharp") return "csharp";
  return language;
}

function fileUriForPath(path: string) {
  const root = rootUri.replace(/\/$/, "");
  return `${root}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function sanitizeHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content
    .querySelectorAll("script, iframe, object, embed, link, style")
    .forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      if (/^on/i.test(attribute.name) || attribute.name === "srcdoc") {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}
