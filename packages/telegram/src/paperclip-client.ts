export class PaperclipApiClient {
  private readonly baseUrl: string;

  constructor(apiUrl = "http://127.0.0.1:3100", private readonly apiKey?: string | undefined) {
    this.baseUrl = apiUrl.replace(/\/+$/, "");
  }

  async getJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Paperclip HTTP GET ${path} failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Paperclip HTTP POST ${path} failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}
