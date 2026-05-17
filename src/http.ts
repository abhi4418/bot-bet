import axios, { type AxiosRequestConfig, type Method } from "axios";
import type { BotConfig } from "./config.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly request: { method: string; url: string },
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class HttpClient {
  constructor(private readonly config: BotConfig) {}

  get<T>(url: string): Promise<T> {
    return this.request<T>(url, { method: "GET" });
  }

  post<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      data: body,
    });
  }

  private async request<T>(url: string, init: AxiosRequestConfig): Promise<T> {
    if (!this.config.authToken) {
      throw new Error("BETBOT_AUTH_TOKEN is required for API calls.");
    }
    assertTokenNotExpired(this.config.authToken);

    const method = normalizeMethod(init.method);
    const response = await axios.request<unknown>({
      ...init,
      url,
      method,
      validateStatus: () => true,
      headers: {
        accept: "application/json",
        "accept-language": this.config.acceptLanguage,
        authorization: this.config.authToken,
        origin: this.config.origin,
        priority: "u=1, i",
        Referer: this.config.referer,
        "sec-ch-ua": "\"Google Chrome\";v=\"141\", \"Not?A_Brand\";v=\"8\", \"Chromium\";v=\"141\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "sec-gpc": "1",
        "user-agent": this.config.userAgent,
        ...init.headers,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(`API request failed with ${response.status} for ${method} ${url}`, response.status, response.data, {
        method,
        url,
      });
    }

    return response.data as T;
  }
}

function normalizeMethod(method: AxiosRequestConfig["method"]): Method {
  return (method ?? "GET").toString().toUpperCase() as Method;
}

function assertTokenNotExpired(token: string): void {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return;
  }

  const expiresAtMs = payload.exp * 1000;
  if (Date.now() < expiresAtMs) {
    return;
  }

  throw new Error(`BETBOT_AUTH_TOKEN expired at ${new Date(expiresAtMs).toISOString()}. Paste a fresh token into .env.`);
}

function decodeJwtPayload(token: string): { exp?: unknown } | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }

  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
}
