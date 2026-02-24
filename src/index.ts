import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  CLAUDE_CODE: DurableObjectNamespace;
  AGENT_LOGS: KVNamespace;
  SLACK_WEBHOOK_URL?: string;
  TARGET_URL?: string;
  TARGET_REPO?: string;
  ANTHROPIC_API_KEY?: string;
}

// Container class - extends Cloudflare's Container base class
export class ClaudeCodeContainer extends Container {
  defaultPort = 4000;  // Port the container server listens on
  sleepAfter = "10m";  // Stop instance after 10 min of inactivity
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

// Helper to sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runAgent(agentId: string, env: Env): Promise<{ success: boolean; output?: string; error?: string }> {
  const agent = AGENTS[agentId];
  if (!agent) {
    return { success: false, error: `Unknown agent: ${agentId}` };
  }

  const startTime = Date.now();
  const logKey = `${agentId}:${startTime}`;
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes max
  const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

  try {
    // Build the full prompt with context
    const fullPrompt = `${agent.prompt}

Target URL: ${env.TARGET_URL || "Not configured"}
Target Repo: ${env.TARGET_REPO || "Not configured"}

Execute your analysis and provide a detailed report.`;

    // Get a container instance for this agent using Cloudflare's getContainer
    const container = getContainer(env.CLAUDE_CODE, agentId);

    // Step 1: Start the task (returns immediately with taskId)
    const startResponse = await container.fetch(new Request("http://container/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: fullPrompt,
        agentId,
      }),
    }));

    if (!startResponse.ok) {
      const error = await startResponse.text();
      throw new Error(`Failed to start task: ${error}`);
    }

    const startResult = await startResponse.json() as { taskId: string; status: string };
    const taskId = startResult.taskId;

    // Step 2: Poll for completion
    let attempts = 0;
    const maxAttempts = Math.ceil(MAX_WAIT_MS / POLL_INTERVAL_MS);
    
    while (attempts < maxAttempts) {
      await sleep(POLL_INTERVAL_MS);
      attempts++;

      const statusResponse = await container.fetch(
        new Request(`http://container/status/${taskId}`)
      );

      if (!statusResponse.ok) {
        throw new Error(`Failed to get task status: ${await statusResponse.text()}`);
      }

      const status = await statusResponse.json() as {
        status: string;
        result?: { raw?: string; result?: string; [key: string]: unknown };
        error?: string;
        stderr?: string;
        exitCode?: number;
      };

      if (status.status === 'completed' || status.status === 'failed') {
        // Task finished
        let output = "No output";
        
        if (status.error) {
          throw new Error(status.error);
        }
        
        if (status.result) {
          if (typeof status.result === "string") {
            output = status.result;
          } else if (status.result.raw) {
            output = status.result.raw;
          } else if (status.result.result) {
            output = String(status.result.result);
          } else {
            output = JSON.stringify(status.result, null, 2);
          }
        }
        
        if (status.stderr) {
          output += `\n\nStderr: ${status.stderr}`;
        }

        if (status.status === 'failed') {
          throw new Error(`Task failed with exit code ${status.exitCode}: ${output}`);
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
      }
    }

    // If we get here, we timed out waiting for the task
    throw new Error(`Task timed out after ${MAX_WAIT_MS / 1000} seconds`);
    
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve dashboard
    if (path === "/" || path === "/index.html") {
      return new Response(DASHBOARD_HTML, {
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

      // Warm up a container (fire and forget)
      const warmMatch = path.match(/^\/api\/agents\/(\w+)\/warm$/);
      if (warmMatch && request.method === "POST") {
        const agentId = warmMatch[1];
        try {
          const container = getContainer(env.CLAUDE_CODE, agentId);
          // Just hit the health endpoint to trigger container start
          const res = await container.fetch(new Request("http://container/health"));
          const data = await res.json() as { status: string };
          return Response.json({ status: "warm", container: data.status });
        } catch (e) {
          // Expected to timeout on cold start - that's fine
          return Response.json({ status: "warming", message: "Container starting..." });
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const hour = new Date(event.scheduledTime).getUTCHours();
    const day = new Date(event.scheduledTime).getUTCDay();

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

    for (const agentId of toRun) {
      ctx.waitUntil(runAgent(agentId, env));
    }
  },
};

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agents</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #faf9f7;
      --surface: #ffffff;
      --border: #e8e6e3;
      --text: #1a1a1a;
      --text-secondary: #6b6b6b;
      --text-tertiary: #999;
      --success: #2d7a4d;
      --error: #c23b3b;
      --running: #b8860b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Newsreader', Georgia, serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 4rem 2rem;
    }

    header { margin-bottom: 4rem; }

    h1 {
      font-size: 2.5rem;
      font-weight: 500;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }

    .subtitle {
      font-size: 1.1rem;
      color: var(--text-secondary);
      font-style: italic;
    }

    .agents {
      display: flex;
      flex-direction: column;
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      margin-bottom: 3rem;
    }

    .agent {
      background: var(--surface);
      padding: 1.5rem 2rem;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2rem;
      align-items: center;
      transition: background 0.15s ease;
    }

    .agent:hover { background: var(--bg); }

    .agent-info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .agent-name {
      font-size: 1.1rem;
      font-weight: 500;
    }

    .agent-desc {
      font-size: 0.95rem;
      color: var(--text-secondary);
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }

    .agent-schedule {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-tertiary);
      background: var(--bg);
      padding: 0.25rem 0.5rem;
      border-radius: 2px;
    }

    .agent-status {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.25rem 0.5rem;
      border-radius: 2px;
    }

    .agent-status.idle { color: var(--text-tertiary); }
    .agent-status.running { color: var(--running); background: rgba(184, 134, 11, 0.1); }
    .agent-status.error { color: var(--error); background: rgba(194, 59, 59, 0.1); }

    .agent-actions { display: flex; gap: 0.75rem; }

    .btn {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.8rem;
      padding: 0.6rem 1.2rem;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn:hover {
      border-color: var(--text);
      background: var(--text);
      color: var(--surface);
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn:disabled:hover {
      background: var(--surface);
      color: var(--text);
      border-color: var(--border);
    }

    .output-section {
      border: 1px solid var(--border);
      background: var(--surface);
    }

    .output-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .output-title {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-tertiary);
    }

    .output-content {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.8rem;
      line-height: 1.8;
      padding: 1.5rem;
      min-height: 200px;
      max-height: 400px;
      overflow-y: auto;
      color: var(--text-secondary);
    }

    .output-line { margin-bottom: 0.25rem; }
    .output-time { color: var(--text-tertiary); margin-right: 1rem; }
    .output-text.success { color: var(--success); }
    .output-text.error { color: var(--error); }
    .output-text.info { color: var(--text); }

    .empty-state {
      color: var(--text-tertiary);
      font-style: italic;
      font-family: 'Newsreader', Georgia, serif;
    }

    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.8rem;
      padding: 1rem 1.5rem;
      background: var(--text);
      color: var(--surface);
      opacity: 0;
      transform: translateY(8px);
      transition: all 0.2s ease;
    }

    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: var(--error); }

    @media (max-width: 768px) {
      .container { padding: 2rem 1rem; }
      .agent { grid-template-columns: 1fr; gap: 1rem; }
      .agent-actions { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Agents</h1>
      <p class="subtitle">Autonomous task execution</p>
    </header>

    <div class="agents" id="agents"></div>

    <div class="output-section">
      <div class="output-header">
        <span class="output-title">Output</span>
        <button class="btn" onclick="clearOutput()">Clear</button>
      </div>
      <div class="output-content" id="output">
        <div class="empty-state">Awaiting command...</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    var agents = [
      { key: 'pentest', name: 'Penetration Tester', schedule: '0 9 * * *', desc: 'Scans for security vulnerabilities and reports findings with severity ratings.' },
      { key: 'bughunter', name: 'Bug Hunter', schedule: '0 10 * * *', desc: 'Analyzes code for bugs, code smells, and potential runtime errors.' },
      { key: 'datainsights', name: 'Data Insights', schedule: '0 11 * * 1', desc: 'Surfaces actionable insights from usage patterns and metrics.' },
      { key: 'feedback', name: 'Feedback Analyzer', schedule: '0 12 * * 1', desc: 'Identifies pain points and prioritizes feature requests from user feedback.' },
      { key: 'investor', name: 'Skeptical Investor', schedule: '0 14 * * 5', desc: 'Challenges assumptions and stress-tests business strategy.' },
      { key: 'kpi', name: 'KPI Analyzer', schedule: '0 9 * * 1', desc: 'Tracks metrics week-over-week and highlights areas needing attention.' },
    ];

    var agentStatus = {};

    function renderAgents() {
      var html = '';
      for (var i = 0; i < agents.length; i++) {
        var agent = agents[i];
        var status = agentStatus[agent.key] || 'idle';
        html += '<div class="agent">' +
          '<div class="agent-info">' +
            '<div class="agent-name">' + agent.name + '</div>' +
            '<div class="agent-desc">' + agent.desc + '</div>' +
            '<div class="agent-meta">' +
              '<span class="agent-schedule">' + agent.schedule + '</span>' +
              (status !== 'idle' ? '<span class="agent-status ' + status + '">' + status + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="agent-actions">' +
            '<button class="btn" onclick="viewLogs(\'' + agent.key + '\')">Logs</button>' +
            '<button class="btn" onclick="runAgent(\'' + agent.key + '\')"' + (status === 'running' ? ' disabled' : '') + '>' +
              (status === 'running' ? 'Running...' : 'Run') +
            '</button>' +
          '</div>' +
        '</div>';
      }
      document.getElementById('agents').innerHTML = html;
    }

    function formatTime(d) {
      return d.toTimeString().slice(0, 8);
    }

    function appendOutput(text, type) {
      var output = document.getElementById('output');
      if (output.querySelector('.empty-state')) output.innerHTML = '';
      
      var line = document.createElement('div');
      line.className = 'output-line';
      line.innerHTML = '<span class="output-time">' + formatTime(new Date()) + '</span><span class="output-text ' + (type || '') + '">' + text + '</span>';
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    }

    function clearOutput() {
      document.getElementById('output').innerHTML = '<div class="empty-state">Awaiting command...</div>';
    }

    function showToast(msg, err) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast' + (err ? ' error' : '');
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, 3000);
    }

    function runAgent(key, retryCount) {
      retryCount = retryCount || 0;
      agentStatus[key] = 'running';
      renderAgents();
      
      if (retryCount === 0) {
        appendOutput('Warming up container...', 'info');
        // First, warm up the container
        fetch('/api/agents/' + key + '/warm', { method: 'POST' })
          .then(function() {
            appendOutput('Starting ' + key + '...', 'info');
            return doRun(key, 0);
          })
          .catch(function() {
            // Warm-up might timeout, that's ok - try run anyway
            appendOutput('Starting ' + key + '...', 'info');
            doRun(key, 0);
          });
      } else {
        doRun(key, retryCount);
      }
    }

    function doRun(key, retryCount) {
      fetch('/api/agents/' + key + '/run', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.success) {
            appendOutput(key + ' completed', 'success');
            if (data.output) {
              var lines = data.output.split('
');
              for (var i = 0; i < lines.length; i++) {
                if (lines[i].trim()) appendOutput(lines[i]);
              }
            }
            showToast('Complete');
            agentStatus[key] = 'idle';
          } else if (data.error && data.error.indexOf('blockConcurrencyWhile') > -1 && retryCount < 3) {
            appendOutput('Container still starting, retrying in 10s... (attempt ' + (retryCount + 2) + '/4)', 'info');
            setTimeout(function() { doRun(key, retryCount + 1); }, 10000);
            return; // Don't reset status yet
          } else {
            appendOutput('Failed: ' + data.error, 'error');
            showToast('Failed', true);
            agentStatus[key] = 'error';
          }
          renderAgents();
        })
        .catch(function(e) {
          if (retryCount < 3) {
            appendOutput('Request failed, retrying in 10s... (attempt ' + (retryCount + 2) + '/4)', 'info');
            setTimeout(function() { doRun(key, retryCount + 1); }, 10000);
            return;
          }
          appendOutput('Error: ' + e.message, 'error');
          showToast('Error', true);
          agentStatus[key] = 'error';
          renderAgents();
        });
    }

    function viewLogs(key) {
      appendOutput('Fetching ' + key + ' logs...', 'info');
      fetch('/api/agents/' + key + '/logs')
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.logs && data.logs !== 'No logs found') {
            var lines = data.logs.split('
');
            for (var i = 0; i < lines.length; i++) {
              if (lines[i].trim()) appendOutput(lines[i]);
            }
          } else {
            appendOutput('No logs found');
          }
        })
        .catch(function(e) {
          appendOutput('Error: ' + e.message, 'error');
        });
    }

    renderAgents();
  </script>
</body>
</html>`;
