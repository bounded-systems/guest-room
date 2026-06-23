/**
 * door-protocol.ts — the generic door protocol (JSON-over-socket).
 *
 * Every door daemon speaks the same wire format:
 *   - Newline-delimited JSON
 *   - Request envelope: { id, method, params? }
 *   - Response envelope: { id, ok, result?, error? }
 *
 * This module extracts the protocol so daemons stay focused on their domain
 * logic (what methods they handle), not the envelope parsing.
 */

import { Buffer } from "node:buffer";

// This module's server half is transport-neutral; its client half (`call`)
// targets Bun's socket API. Rather than depend on `@types/bun` (a bare "bun"
// specifier JSR cannot resolve), we declare the minimal structural surface we
// touch locally — Bun's real types are structurally assignable, so consumers on
// Bun are unaffected and the module carries no unresolvable dependency.

/** The subset of a connection socket the server handlers use: a per-connection
 *  `data` bag plus `write`. Bun's `Socket<Cx>` is structurally assignable. */
export interface DoorSocket<Cx> {
  /** Per-connection state bag (context data). */
  data: Cx;
  /** Write data (string or bytes) to the socket; returns bytes written. */
  write(data: string | Uint8Array): number;
}

/** The subset of a Bun client socket `call` uses. */
interface ClientSocket {
  write(data: string | Uint8Array): number;
  end(): void;
}

/** Bun's runtime global, declared locally with only the shape `call` needs (so
 *  the module type-checks without @types/bun). At runtime this is Bun's global,
 *  so `call` runs under the Bun runtime. */
declare const Bun: {
  connect(options: {
    unix: string;
    socket: {
      data(socket: ClientSocket, chunk: Uint8Array): void;
      open(socket: ClientSocket): void;
      error(socket: ClientSocket, error: Error): void;
      close(socket: ClientSocket): void;
    };
  }): Promise<{ catch(onrejected: (reason: unknown) => void): unknown }>;
};

// ── Protocol types (shared across all doors) ────────────────────────────────

/** JSON-RPC 2.0-like request envelope: method call with id, method name, and optional params. */
export type RequestEnvelope = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

/** Response envelope: result (if ok=true) or error object (if ok=false). */
export type ResponseEnvelope = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

// ── Response helpers ────────────────────────────────────────────────────────

/** Create a success response */
export function ok(id: string, result?: unknown): ResponseEnvelope {
  return { id, ok: true, result };
}

/** Create an error response */
export function err(id: string, code: string, message: string): ResponseEnvelope {
  return { id, ok: false, error: { code, message } };
}

// ── Connection handler ──────────────────────────────────────────────────────

/** A method handler: takes params and returns a result (sync or async). */
export type MethodHandler = (
  params: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Registry of method handlers (name → handler). */
export type MethodRegistry = Record<string, MethodHandler>;

/**
 * Create socket handlers for a door daemon.
 *
 * @example
 *   const handlers = createDoorHandlers("myservice", {
 *     greet: async (params) => ({ message: `Hello, ${params.name}` }),
 *   }, log);
 *   listen({ unix: "/run/myservice.sock", socket: handlers });
 */
export function createDoorHandlers<Cx extends { buffer: string }>(
  name: string,
  methods: MethodRegistry,
  log: (level: "INFO" | "ERR" | "ALLOW" | "DENY" | "WARN", msg: string) => void,
): {
  open: (socket: DoorSocket<Cx>) => void;
  data: (socket: DoorSocket<Cx>, chunk: Uint8Array) => void;
  close: (socket: DoorSocket<Cx>) => void;
  error: (socket: DoorSocket<Cx>, error: Error) => void;
} {
  return {
    open(socket) {
      socket.data = { buffer: "" } as Cx;
    },

    async data(socket, chunk) {
      socket.data.buffer += Buffer.from(chunk).toString("utf-8");
      const lines = socket.data.buffer.split("\n");
      socket.data.buffer = lines.pop()!; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        const response = await handleLine(line, methods, log);
        socket.write(JSON.stringify(response) + "\n");
      }
    },

    close(_socket) {
      // Nothing to clean up in the generic case
    },

    error(_socket, error) {
      log("ERR", `socket error: ${error.message}`);
    },
  };
}

async function handleLine(
  line: string,
  methods: MethodRegistry,
  log: (level: "INFO" | "ERR" | "ALLOW" | "DENY" | "WARN", msg: string) => void,
): Promise<ResponseEnvelope> {
  let req: RequestEnvelope;
  try {
    req = JSON.parse(line) as RequestEnvelope;
  } catch {
    return err("?", "PARSE_ERROR", "invalid JSON");
  }

  const handler = methods[req.method];
  if (!handler) {
    log("ERR", `unknown method: ${req.method}`);
    return err(req.id, "UNKNOWN_METHOD", `unknown method: ${req.method}`);
  }

  try {
    const result = await handler(req.params ?? {});
    return ok(req.id, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("ERR", `${req.method}: ${message}`);
    return err(req.id, "HANDLER_ERROR", message);
  }
}

// ── Client helper ───────────────────────────────────────────────────────────

/**
 * Resolve a door endpoint to a Bun.connect target. A leading "/" (optionally
 * `unix://`) is a unix socket path; otherwise `host:port` (optionally `tcp://`)
 * is a TCP target — so the same client reaches a mounted unix socket (Linux/pod)
 * or a host-gateway / pod-local TCP port (e.g. macOS, where virtiofs can't share
 * a unix socket across the host↔VM boundary). A path containing ":" stays unix.
 */
function connectTarget(endpoint: string): { unix: string } | { hostname: string; port: number } {
  const stripped = endpoint.replace(/^unix:\/\//, "");
  if (!stripped.startsWith("/")) {
    const m = stripped.replace(/^tcp:\/\//, "").match(/^([^/\s]+):(\d{1,5})$/);
    if (m) return { hostname: m[1]!, port: Number(m[2]) };
  }
  return { unix: stripped };
}

/**
 * Send a request to a door daemon and wait for the response. The endpoint is a
 * unix socket path or a `host:port` TCP target (see {@link connectTarget}).
 *
 * @example
 *   const result = await call("/run/myservice.sock", "greet", { name: "world" });
 *   const viaTcp = await call("host.containers.internal:3002", "greet", { name: "world" });
 */
export async function call<T = unknown>(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = crypto.randomUUID();
  const req: RequestEnvelope = { id, method, params };

  return new Promise((resolve, reject) => {
    let buffer = "";
    const socket = Bun.connect({
      ...connectTarget(endpoint),
      socket: {
        data(_socket, chunk) {
          buffer += Buffer.from(chunk).toString("utf-8");
          const idx = buffer.indexOf("\n");
          if (idx !== -1) {
            const line = buffer.slice(0, idx);
            try {
              const resp = JSON.parse(line) as ResponseEnvelope;
              if (resp.ok) {
                resolve(resp.result as T);
              } else {
                reject(new Error(resp.error?.message ?? "unknown error"));
              }
            } catch (e) {
              reject(e);
            }
            _socket.end();
          }
        },
        open(socket) {
          socket.write(JSON.stringify(req) + "\n");
        },
        error(_socket, error) {
          reject(error);
        },
        close() {},
      },
    });
    socket.catch(reject);
  });
}
