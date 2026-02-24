import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  CLAUDE_CODE: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
}

export class ClaudeCodeContainer extends Container {
  defaultPort = 4000;
  sleepAfter = "30m"; // Keep alive for 30 min after last request
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Health check for the worker itself
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          service: "claude-code-container",
          endpoints: {
            "/run": "POST - Run Claude Code with a prompt",
            "/clone": "POST - Clone a git repo",
            "/files": "GET - List files in workspace",
            "/read": "GET - Read a file",
            "/health": "GET - Container health check",
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Get session ID from query param or generate one
    const sessionId = url.searchParams.get("session") || "default";

    // Get or create the container instance for this session
    const container = getContainer(env.CLAUDE_CODE, sessionId);

    // For /run, inject the API key if not provided
    if (url.pathname === "/run" && request.method === "POST") {
      const body = await request.json() as Record<string, unknown>;
      if (!body.apiKey && env.ANTHROPIC_API_KEY) {
        body.apiKey = env.ANTHROPIC_API_KEY;
      }

      const containerRequest = new Request(
        `http://container${url.pathname}${url.search}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const response = await container.fetch(containerRequest);
      return addCors(response);
    }

    // Forward all other requests to the container
    const containerRequest = new Request(
      `http://container${url.pathname}${url.search}`,
      {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" ? request.body : undefined,
      }
    );

    const response = await container.fetch(containerRequest);
    return addCors(response);
  },
};

function addCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
