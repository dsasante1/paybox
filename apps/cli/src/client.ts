/**
 * REST client for the running emulator.
 *
 * The CLI is deliberately a thin client over the same /api the dashboard uses,
 * not a second way into the engine. One control plane means one set of
 * semantics: anything the CLI can do, the dashboard can do, and neither can
 * drift from the other.
 */
export class PayboxClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CliError(
        `Could not reach the emulator at ${this.#baseUrl}.\n` +
          'Is it running? Start it with `paybox start`.',
        { cause: error },
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      const detail = parsed as { message?: string; error?: string } | null;
      throw new CliError(detail?.message ?? `${response.status} ${response.statusText}`);
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async isUp(): Promise<boolean> {
    try {
      await this.get('/api/health');
      return true;
    } catch {
      return false;
    }
  }
}

/** An error whose message is meant for a human, printed without a stack. */
export class CliError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CliError';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 400) };
  }
}
