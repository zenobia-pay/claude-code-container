// Container binding type
interface ContainerBinding {
  getContainer(id: string): Promise<{ url: string }>;
  get(id: DurableObjectId): DurableObjectStub;
  idFromName(name: string): DurableObjectId;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request | string): Promise<Response>;
}

interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<Map<string, unknown>>;
}

interface Env {
  CLAUDE_CODE: ContainerBinding;
  AGENT_LOGS: KVNamespace;
  SLACK_WEBHOOK_URL?: string;
  TARGET_URL?: string;
  TARGET_REPO?: string;
  ANTHROPIC_API_KEY?: string;
}

// Agent definitions
const AGENTS: Record<string, { name: string; prompt: string }> = {
  pentest: {
    name: "Penetration Tester",
    prompt: `You are a security penetration tester. Analyze the target site for vulnerabilities:
- Test for common web vulnerabilities (XSS, CSRF, SQL injection, etc.)
- Check security headers and SSL configuration
- Look for exposed sensitive files or endpoints
- Test authentication mechanisms if present
Report findings with severity ratings (Critical/High/Medium/Low/Info).`,
  },
  bughunter: {
    name: "Bug Hunter",
    prompt: `You are a bug hunter. Clone and analyze the target repository:
- Look for potential bugs and runtime errors
- Identify code smells and anti-patterns
- Check for memory leaks or performance issues
- Review error handling and edge cases
Report issues with code locations and suggested fixes.`,
  },
  datainsights: {
    name: "Data Insights Analyst",
    prompt: `You are a data analyst. Analyze available metrics and data:
- Identify trends and patterns in usage
- Find anomalies that need investigation
- Surface growth opportunities
- Recommend data-driven actions
Provide actionable insights with supporting evidence.`,
  },
  feedback: {
    name: "Feedback Analyzer",
    prompt: `You are a user feedback analyst. Review all available feedback:
- Categorize common complaints and requests
- Identify pain points in user experience
- Prioritize issues by frequency and impact
- Extract feature requests and suggestions
Summarize findings with recommended priorities.`,
  },
  investor: {
    name: "Skeptical Investor",
    prompt: `You are a skeptical investor doing due diligence:
- Challenge core business assumptions
- Identify market risks and competitive threats
- Question unit economics and growth projections
- Find weaknesses in the business model
Be constructively critical - poke holes that need addressing.`,
  },
  kpi: {
    name: "KPI Analyzer",
    prompt: `You are a KPI analyst. Track and analyze key metrics:
- Compare current metrics to previous periods
- Identify metrics trending in wrong direction
- Highlight wins and areas of concern
- Recommend focus areas for improvement
Provide a clear weekly health summary.`,
  },
};

async function runAgent(agentId: string, env: Env): Promise<{ success: boolean; output?: string; error?: string }> {
  const agent = AGENTS[agentId];
  if (!agent) {
    return { success: false, error: `Unknown agent: ${agentId}` };
  }

  const startTime = Date.now();
  const logKey = `${agentId}:${startTime}`;

  try {
    // Build the full prompt with context
    const fullPrompt = `${agent.prompt}

Target URL: ${env.TARGET_URL || "Not configured"}
Target Repo: ${env.TARGET_REPO || "Not configured"}

Execute your analysis and provide a detailed report.`;

    // Get a Durable Object stub for this agent's container
    const id = env.CLAUDE_CODE.idFromName(agentId);
    const stub = env.CLAUDE_CODE.get(id);

    // Call the container via DO stub
    const response = await stub.fetch(new Request("http://container/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: fullPrompt,
        agentId,
        agentName: agent.name,
      }),
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Container error: ${error}`);
    }

    const result = await response.json() as { 
      exitCode?: number; 
      result?: { raw?: string; result?: string; [key: string]: unknown }; 
      stderr?: string;
      error?: string;
    };
    
    // Extract output from Claude Code response
    let output = "No output";
    if (result.error) {
      throw new Error(result.error);
    }
    if (result.result) {
      if (typeof result.result === "string") {
        output = result.result;
      } else if (result.result.raw) {
        output = result.result.raw;
      } else if (result.result.result) {
        output = String(result.result.result);
      } else {
        output = JSON.stringify(result.result, null, 2);
      }
    }
    if (result.stderr) {
      output += `\n\nStderr: ${result.stderr}`;
    }
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Store log
    await env.AGENT_LOGS.put(
      logKey,
      JSON.stringify({
        agentId,
        agentName: agent.name,
        timestamp: new Date().toISOString(),
        duration: `${duration}s`,
        output,
        success: true,
      }),
      { expirationTtl: 60 * 60 * 24 * 7 } // 7 days
    );

    // Send Slack notification if configured
    if (env.SLACK_WEBHOOK_URL) {
      await sendSlackNotification(env.SLACK_WEBHOOK_URL, agent.name, output, true);
    }

    return { success: true, output };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Store error log
    await env.AGENT_LOGS.put(
      logKey,
      JSON.stringify({
        agentId,
        agentName: agent.name,
        timestamp: new Date().toISOString(),
        duration: `${duration}s`,
        error,
        success: false,
      }),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );

    // Send Slack notification for failure
    if (env.SLACK_WEBHOOK_URL) {
      await sendSlackNotification(env.SLACK_WEBHOOK_URL, agent.name, error, false);
    }

    return { success: false, error };
  }
}

async function sendSlackNotification(webhookUrl: string, agentName: string, message: string, success: boolean) {
  const emoji = success ? "✅" : "❌";
  const status = success ? "completed" : "failed";

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emoji} *${agentName}* ${status}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${emoji} *${agentName}* ${status}\n\`\`\`${message.slice(0, 2500)}${message.length > 2500 ? "..." : ""}\`\`\``,
          },
        },
      ],
    }),
  });
}

async function getAgentLogs(agentId: string, env: Env): Promise<string> {
  const list = await env.AGENT_LOGS.list({ prefix: `${agentId}:` });
  if (list.keys.length === 0) {
    return "No logs found";
  }

  // Get most recent 5 logs
  const recentKeys = list.keys.slice(-5);
  const logs: string[] = [];

  for (const key of recentKeys) {
    const log = await env.AGENT_LOGS.get(key.name);
    if (log) {
      const parsed = JSON.parse(log);
      logs.push(`[${parsed.timestamp}] ${parsed.success ? "✅" : "❌"} Duration: ${parsed.duration}\n${parsed.output || parsed.error}`);
    }
  }

  return logs.join("\n\n---\n\n");
}

// Static file serving
const DASHBOARD_HTML = `PLACEHOLDER`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve dashboard
    if (path === "/" || path === "/index.html") {
      // In production, we'd serve from assets. For now, redirect to public asset
      return new Response(await getAsset(env, "index.html"), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // API routes
    if (path.startsWith("/api/")) {
      // Run agent
      const runMatch = path.match(/^\/api\/agents\/(\w+)\/run$/);
      if (runMatch && request.method === "POST") {
        const result = await runAgent(runMatch[1], env);
        return Response.json(result);
      }

      // Get logs
      const logsMatch = path.match(/^\/api\/agents\/(\w+)\/logs$/);
      if (logsMatch) {
        const logs = await getAgentLogs(logsMatch[1], env);
        return Response.json({ logs });
      }

      // List agents
      if (path === "/api/agents") {
        return Response.json(
          Object.entries(AGENTS).map(([id, agent]) => ({
            id,
            name: agent.name,
          }))
        );
      }

      // Health check
      if (path === "/api/health") {
        return Response.json({
          status: "ok",
          targetUrl: env.TARGET_URL || "not set",
          targetRepo: env.TARGET_REPO || "not set",
          slackConfigured: !!env.SLACK_WEBHOOK_URL,
        });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const hour = new Date(event.scheduledTime).getUTCHours();
    const day = new Date(event.scheduledTime).getUTCDay();

    // Map cron triggers to agents based on schedule
    // 0 9 * * * - pentest (daily 9 AM)
    // 0 10 * * * - bughunter (daily 10 AM)
    // 0 11 * * 1 - datainsights (Mon 11 AM)
    // 0 12 * * 1 - feedback (Mon 12 PM)
    // 0 14 * * 5 - investor (Fri 2 PM)
    // 0 9 * * 1 - kpi (Mon 9 AM)

    const toRun: string[] = [];

    if (hour === 9 && day === 1) {
      toRun.push("kpi");
    }
    if (hour === 9) {
      toRun.push("pentest");
    }
    if (hour === 10) {
      toRun.push("bughunter");
    }
    if (hour === 11 && day === 1) {
      toRun.push("datainsights");
    }
    if (hour === 12 && day === 1) {
      toRun.push("feedback");
    }
    if (hour === 14 && day === 5) {
      toRun.push("investor");
    }

    // Run all scheduled agents (they'll get their own containers)
    for (const agentId of toRun) {
      ctx.waitUntil(runAgent(agentId, env));
    }
  },
};

// Asset helper - in production use Cloudflare Pages or assets binding
async function getAsset(_env: Env, _name: string): Promise<string> {
  // This will be replaced by proper asset serving
  // For now, inline the dashboard or use a fetch
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Code Agents</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #faf8f5;
      color: #2d2d2d;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #1a1a1a;
    }
    .subtitle {
      color: #666;
      margin-bottom: 2rem;
      font-size: 0.95rem;
    }
    .agents {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1rem;
    }
    .agent {
      background: #fff;
      border: 1px solid #e5e2dd;
      border-radius: 12px;
      padding: 1.25rem;
      transition: box-shadow 0.15s ease;
    }
    .agent:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
    .agent-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.75rem;
    }
    .agent-name {
      font-weight: 600;
      font-size: 1rem;
      color: #1a1a1a;
    }
    .agent-schedule {
      font-size: 0.75rem;
      color: #888;
      background: #f5f3f0;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
    }
    .agent-desc {
      font-size: 0.875rem;
      color: #555;
      line-height: 1.5;
      margin-bottom: 1rem;
    }
    .agent-actions { display: flex; gap: 0.5rem; }
    .btn {
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
    }
    .btn-primary {
      background: #2563eb;
      color: #fff;
    }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-primary:disabled {
      background: #93c5fd;
      cursor: not-allowed;
    }
    .btn-secondary {
      background: #f5f3f0;
      color: #444;
      border: 1px solid #e5e2dd;
    }
    .btn-secondary:hover { background: #eae7e2; }
    .status {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 0.5rem;
    }
    .status-idle { background: #9ca3af; }
    .status-running { background: #22c55e; animation: pulse 1.5s infinite; }
    .status-error { background: #ef4444; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .output-panel {
      margin-top: 2rem;
      background: #fff;
      border: 1px solid #e5e2dd;
      border-radius: 12px;
      overflow: hidden;
    }
    .output-header {
      padding: 1rem 1.25rem;
      background: #f9f8f6;
      border-bottom: 1px solid #e5e2dd;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .output-content {
      padding: 1rem 1.25rem;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.8rem;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: #374151;
      line-height: 1.6;
    }
    .empty-state {
      color: #9ca3af;
      text-align: center;
      padding: 3rem;
    }
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #1a1a1a;
      color: #fff;
      padding: 0.75rem 1.25rem;
      border-radius: 8px;
      font-size: 0.875rem;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      z-index: 100;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Claude Code Agents</h1>
    <p class="subtitle">AI-powered autonomous agents running on Cloudflare Containers</p>
    
    <div class="agents" id="agents"></div>
    
    <div class="output-panel">
      <div class="output-header">
        <span>Output</span>
        <button class="btn btn-secondary" onclick="clearOutput()">Clear</button>
      </div>
      <div class="output-content" id="output">
        <div class="empty-state">Run an agent to see output here</div>
      </div>
    </div>
  </div>
  
  <div class="toast" id="toast"></div>

  <script>
    const agents = [
      {
        id: 'pentest',
        name: 'Penetration Tester',
        schedule: '0 9 * * *',
        desc: 'Scans the target site for security vulnerabilities, tests common attack vectors, and reports findings with severity ratings.',
      },
      {
        id: 'bughunter',
        name: 'Bug Hunter',
        schedule: '0 10 * * *',
        desc: 'Clones the target repo and hunts for bugs, code smells, and potential runtime errors. Files issues or reports findings.',
      },
      {
        id: 'datainsights',
        name: 'Data Insights',
        schedule: '0 11 * * 1',
        desc: 'Analyzes usage patterns, metrics, and data to surface actionable insights and growth opportunities.',
      },
      {
        id: 'feedback',
        name: 'Feedback Analyzer',
        schedule: '0 12 * * 1',
        desc: 'Reviews user feedback, support tickets, and reviews to identify common pain points and feature requests.',
      },
      {
        id: 'investor',
        name: 'Skeptical Investor',
        schedule: '0 14 * * 5',
        desc: 'Plays devil\\'s advocate on the business — pokes holes in strategy, questions assumptions, and stress-tests the pitch.',
      },
      {
        id: 'kpi',
        name: 'KPI Analyzer',
        schedule: '0 9 * * 1',
        desc: 'Tracks key performance indicators, compares week-over-week changes, and highlights metrics that need attention.',
      },
    ];

    const agentStatus = {};

    function renderAgents() {
      const container = document.getElementById('agents');
      container.innerHTML = agents.map(agent => \`
        <div class="agent" id="agent-\${agent.id}">
          <div class="agent-header">
            <div>
              <span class="status status-\${agentStatus[agent.id] || 'idle'}"></span>
              <span class="agent-name">\${agent.name}</span>
            </div>
            <span class="agent-schedule">\${agent.schedule}</span>
          </div>
          <p class="agent-desc">\${agent.desc}</p>
          <div class="agent-actions">
            <button class="btn btn-primary" onclick="runAgent('\${agent.id}')" \${agentStatus[agent.id] === 'running' ? 'disabled' : ''}>
              \${agentStatus[agent.id] === 'running' ? 'Running...' : 'Run Now'}
            </button>
            <button class="btn btn-secondary" onclick="viewLogs('\${agent.id}')">View Logs</button>
          </div>
        </div>
      \`).join('');
    }

    function appendOutput(text) {
      const output = document.getElementById('output');
      if (output.querySelector('.empty-state')) {
        output.innerHTML = '';
      }
      output.textContent += text + '\\n';
      output.scrollTop = output.scrollHeight;
    }

    function clearOutput() {
      document.getElementById('output').innerHTML = '<div class="empty-state">Run an agent to see output here</div>';
    }

    function showToast(message) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    async function runAgent(id) {
      agentStatus[id] = 'running';
      renderAgents();
      appendOutput(\`[\${new Date().toISOString()}] Starting \${id}...\`);
      
      try {
        const res = await fetch(\`/api/agents/\${id}/run\`, { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          appendOutput(\`[\${new Date().toISOString()}] \${id} completed successfully\`);
          if (data.output) appendOutput(data.output);
          showToast(\`\${id} completed!\`);
          agentStatus[id] = 'idle';
        } else {
          appendOutput(\`[\${new Date().toISOString()}] \${id} failed: \${data.error}\`);
          showToast(\`\${id} failed\`);
          agentStatus[id] = 'error';
        }
      } catch (err) {
        appendOutput(\`[\${new Date().toISOString()}] \${id} error: \${err.message}\`);
        showToast(\`\${id} error\`);
        agentStatus[id] = 'error';
      }
      
      renderAgents();
    }

    async function viewLogs(id) {
      appendOutput(\`[\${new Date().toISOString()}] Fetching logs for \${id}...\`);
      try {
        const res = await fetch(\`/api/agents/\${id}/logs\`);
        const data = await res.json();
        if (data.logs) {
          appendOutput(\`--- Logs for \${id} ---\`);
          appendOutput(data.logs);
          appendOutput(\`--- End logs ---\`);
        } else {
          appendOutput(\`No logs found for \${id}\`);
        }
      } catch (err) {
        appendOutput(\`Error fetching logs: \${err.message}\`);
      }
    }

    renderAgents();
  </script>
</body>
</html>`;
}

// Durable Object class for Cloudflare Containers
// The container runs as a sidecar and is accessible via localhost:4000
export class ClaudeCodeContainer {
  private state: DurableObjectState;
  private env: Env;
  private container: { fetch: typeof fetch } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // @ts-ignore - Cloudflare Containers provides this.ctx.container
    if ((this as any).ctx?.container) {
      // @ts-ignore
      this.container = (this as any).ctx.container;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Forward to container on port 4000
    const containerUrl = `http://127.0.0.1:4000${url.pathname}${url.search}`;
    
    try {
      // If we have the container binding, use it
      if (this.container) {
        return await this.container.fetch(new Request(containerUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method !== "GET" ? await request.text() : undefined,
        }));
      }
      
      // Otherwise try direct fetch to localhost
      const response = await fetch(containerUrl, {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: request.method !== "GET" ? await request.text() : undefined,
      });
      
      return new Response(response.body, {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });
    } catch (err) {
      return Response.json({ 
        error: `Container error: ${err instanceof Error ? err.message : String(err)}` 
      }, { status: 500 });
    }
  }
}
