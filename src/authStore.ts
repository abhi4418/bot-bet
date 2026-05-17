import axios from "axios";

// ---------------------------------------------------------------------------
// In-memory auth token store
// ---------------------------------------------------------------------------
// The token is stored here at runtime. On startup it can be seeded from the
// env value (see UserTelegramClient / HttpClient). Once the user types `login`
// in the Telegram update group the token is replaced here without touching .env.

let _authToken: string = "";

export function getAuthToken(): string {
  return _authToken;
}

export function setAuthToken(token: string): void {
  _authToken = token.trim();
}

export function isAuthTokenSet(): boolean {
  return _authToken.length > 0;
}

export function clearAuthToken(): void {
  _authToken = "";
}

// ---------------------------------------------------------------------------
// Login API
// ---------------------------------------------------------------------------

const LOGIN_URL = "https://api.uvwin2024.co/account/v2/login";

const LOGIN_HEADERS = {
  accept: "application/json",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7",
  "content-type": "application/json",
  dnt: "1",
  origin: "https://www.crypto247.club",
  priority: "u=1, i",
  referer: "https://www.crypto247.club/",
  "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "sec-fetch-storage-access": "active",
  "sec-gpc": "1",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

/**
 * Calls the login API with the supplied credentials and stores the returned
 * token in memory.  Returns the token string on success.
 */
export async function loginAndStore(username: string, password: string): Promise<string> {
  const response = await axios.post<unknown>(
    LOGIN_URL,
    {
      username,
      password,
      otp: "",
      loginRequestType: "PHONE_SIGN_IN",
    },
    {
      headers: LOGIN_HEADERS,
      validateStatus: () => true,
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Login failed with HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }

  // The API returns just the token string (or an object with a token field).
  // Handle both shapes.
  let token: string;
  if (typeof response.data === "string") {
    token = response.data.trim();
  } else if (response.data && typeof (response.data as Record<string, unknown>).token === "string") {
    token = ((response.data as Record<string, unknown>).token as string).trim();
  } else {
    throw new Error(`Unexpected login response shape: ${JSON.stringify(response.data)}`);
  }

  if (!token) {
    throw new Error("Login API returned an empty token.");
  }

  setAuthToken(token);
  return token;
}
