import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface JulesFixtureResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface JulesFixtureStep {
  readonly method: "GET" | "POST";
  readonly pathname: string;
  readonly response: JulesFixtureResponse;
}

export interface JulesFixtureRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

export interface ScriptedJulesServer {
  readonly baseUrl: string;
  requests(): readonly JulesFixtureRequest[];
  remainingSteps(): readonly JulesFixtureStep[];
  close(): Promise<void>;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, fixture: JulesFixtureResponse): void {
  response.writeHead(fixture.status, { "content-type": "application/json" });
  response.end(JSON.stringify(fixture.body));
}

/**
 * A deliberately strict local HTTP implementation of the Jules request
 * boundary. It records the real wire payload and consumes each expected
 * request once, so an accidental retry is observable instead of being hidden
 * behind a permissive fetch mock.
 */
export async function startScriptedJulesServer(
  script: readonly JulesFixtureStep[],
): Promise<ScriptedJulesServer> {
  const steps = [...script];
  const requests: JulesFixtureRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readJsonBody(request);
    const observed: JulesFixtureRequest = {
      method: request.method ?? "GET",
      pathname: url.pathname,
      body,
    };
    requests.push(observed);
    const next = steps.shift();
    if (!next || next.method !== observed.method || next.pathname !== observed.pathname) {
      sendJson(response, {
        status: 500,
        body: {
          error: "unexpected scripted Jules request",
          expected: next ? { method: next.method, pathname: next.pathname } : null,
          observed,
        },
      });
      return;
    }
    sendJson(response, next.response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Scripted Jules server did not bind a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1alpha`,
    requests: () => requests.map((entry) => ({ ...entry })),
    remainingSteps: () => steps.map((entry) => ({ ...entry })),
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
