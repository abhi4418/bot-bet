import axios, { type AxiosRequestConfig, type Method } from "axios";
import type { BotConfig } from "./config.ts";
import { getAuthToken } from "./authStore.ts";

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
    const authToken = getAuthToken();
    if (!authToken) {
      throw new Error("No auth token set. Type 'login' in the Telegram update group to authenticate.");
    }
    assertTokenNotExpired(authToken);

    const method = normalizeMethod(init.method);
    const requestConfig: AxiosRequestConfig = {
      ...init,
      url,
      method,
      validateStatus: () => true,
      headers: {
        accept: "application/json",
        "accept-language": this.config.acceptLanguage,
        authorization: authToken,
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
    };

    // Retry with exponential back-off on 429 Too Many Requests
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 2000;

    let lastStatus = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await axios.request<unknown>(requestConfig);
      lastStatus = response.status;

      if (response.status === 429) {
        if (attempt < MAX_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s, 8s
          console.warn(`[HTTP] 429 Too Many Requests for ${method} ${url} — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        // Exhausted retries
        throw new ApiError(`API rate-limited (429) after ${MAX_RETRIES} retries for ${method} ${url}`, 429, response.data, { method, url });
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ApiError(`API request failed with ${response.status} for ${method} ${url}`, response.status, response.data, {
          method,
          url,
        });
      }

      return response.data as T;
    }

    // Should not be reached
    throw new ApiError(`API request failed with ${lastStatus} for ${method} ${url}`, lastStatus, null, { method, url });
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

  throw new Error(`Auth token expired at ${new Date(expiresAtMs).toISOString()}. Type 'login' in the Telegram update group to re-authenticate.`);
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
