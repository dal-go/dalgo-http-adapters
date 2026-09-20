import { AlreadyExistsError, NotFoundError, UnsupportedError, type Key } from "@dal-go/dalgo";

export type AccessTokenProvider = () => string | undefined | Promise<string | undefined>;

export interface OpenVaultDbClientOptions {
  readonly baseUrl: string;
  readonly databaseId: string;
  readonly accessToken?: string;
  readonly getAccessToken?: AccessTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
}

interface ErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

export class OpenVaultDbHttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(`OpenVaultDB request failed (${status.toString()} ${code}): ${message}`, options);
    this.name = "OpenVaultDbHttpError";
    this.status = status;
    this.code = code;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("OpenVaultDB base URL must use http or https");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("OpenVaultDB base URL must not contain credentials, query parameters, or a fragment");
  }
  return url.href.replace(/\/$/u, "");
}

async function responseError(response: Response): Promise<OpenVaultDbHttpError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = await response.json() as ErrorEnvelope;
  } catch {
    // A non-JSON error response is still represented without exposing headers.
  }
  return new OpenVaultDbHttpError(
    response.status,
    envelope.error?.code ?? "unknown",
    envelope.error?.message ?? response.statusText,
  );
}

export function translateOpenVaultDbError(error: unknown, key?: Key): unknown {
  if (!(error instanceof OpenVaultDbHttpError)) return error;
  if (error.status === 404 && key !== undefined) return new NotFoundError(key, { cause: error });
  if (error.status === 409 && key !== undefined) return new AlreadyExistsError(key, { cause: error });
  if (error.status === 501 || (error.status === 422
    && (error.code === "not_supported" || error.code === "authorization_unsupported"))) {
    return new UnsupportedError(error.code, { cause: error });
  }
  return error;
}

export class OpenVaultDbClient {
  readonly #baseUrl: string;
  readonly #databaseId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #accessToken: string | undefined;
  readonly #getAccessToken: AccessTokenProvider | undefined;

  public constructor(options: OpenVaultDbClientOptions) {
    if (options.databaseId.trim().length === 0) throw new TypeError("OpenVaultDB database ID is required");
    if (options.accessToken !== undefined && options.getAccessToken !== undefined) {
      throw new TypeError("provide either accessToken or getAccessToken, not both");
    }
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#databaseId = encodeURIComponent(options.databaseId);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#accessToken = options.accessToken;
    this.#getAccessToken = options.getAccessToken;
  }

  public recordPath(key: Key): string {
    return `/v1/databases/${this.#databaseId}/records/${key.path}`;
  }

  public queryPath(): string {
    return `/v1/databases/${this.#databaseId}/query`;
  }

  public batchPath(): string {
    return `/v1/databases/${this.#databaseId}/batch`;
  }

  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.#getAccessToken === undefined
      ? this.#accessToken
      : await this.#getAccessToken();
    const headers = new Headers(init.headers);
    if (token !== undefined && token.length > 0) headers.set("Authorization", `Bearer ${token}`);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "error",
    });
    if (!response.ok) throw await responseError(response);
    return response;
  }
}
