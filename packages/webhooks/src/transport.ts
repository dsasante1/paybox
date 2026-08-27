import { request } from 'undici';
import type { DeliveryTransport, TransportRequest, TransportResult } from './types.js';

/**
 * Real HTTP delivery over undici.
 *
 * Deliberately does no retrying of its own: retries are the webhook engine's
 * job, because they must be visible in the dashboard, count against a policy,
 * and be schedulable on virtual time. A client-level retry would be invisible
 * to all three.
 */
export class UndiciTransport implements DeliveryTransport {
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    // Durations are measured on the wall clock deliberately: "how long did my
    // handler take" is a real-world number, not a virtual one.
    this.#now = options.now ?? (() => performance.now());
  }

  async send(req: TransportRequest): Promise<TransportResult> {
    const startedAt = this.#now();
    try {
      const response = await request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        headersTimeout: req.timeoutMs,
        bodyTimeout: req.timeoutMs,
      });
      const text = await response.body.text();
      return {
        status: response.statusCode,
        // Cap the stored body: a developer's error page can be megabytes and
        // this row is displayed in a dashboard table.
        body: text.slice(0, 8_192),
        durationMs: Math.round(this.#now() - startedAt),
        error: null,
      };
    } catch (error) {
      return {
        status: null,
        body: null,
        durationMs: Math.round(this.#now() - startedAt),
        error: describeTransportError(error),
      };
    }
  }
}

function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connection refused. Is your webhook endpoint running?';
    case 'ENOTFOUND':
      return 'Host not found.';
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'Request timed out.';
    case 'ECONNRESET':
      return 'Connection reset by peer.';
    default:
      return error.message;
  }
}

/** In-memory transport for tests and for `--dry-run`. */
export class RecordingTransport implements DeliveryTransport {
  readonly sent: TransportRequest[] = [];
  #responder: (req: TransportRequest) => TransportResult;

  constructor(responder?: (req: TransportRequest) => TransportResult) {
    this.#responder =
      responder ?? (() => ({ status: 200, body: '{"ok":true}', durationMs: 1, error: null }));
  }

  respondWith(responder: (req: TransportRequest) => TransportResult): void {
    this.#responder = responder;
  }

  async send(req: TransportRequest): Promise<TransportResult> {
    this.sent.push(req);
    return this.#responder(req);
  }
}
