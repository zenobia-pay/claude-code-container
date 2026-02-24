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
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Georgia, serif; background: #faf9f7; color: #1a1a1a; padding: 4rem 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .subtitle { color: #666; font-style: italic; margin-bottom: 3rem; }
    .agents { border: 1px solid #ddd; margin-bottom: 2rem; }
    .agent { padding: 1.5rem; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: center; }
    .agent:last-child { border-bottom: none; }
    .agent:hover { background: #f5f5f5; }
    .agent-name { font-weight: bold; margin-bottom: 0.25rem; }
    .agent-desc { color: #666; font-size: 0.9rem; }
    .agent-schedule { font-family: monospace; font-size: 0.75rem; color: #999; margin-top: 0.5rem; }
    .buttons { display: flex; gap: 0.5rem; }
    button { font-family: monospace; padding: 0.5rem 1rem; border: 1px solid #ddd; background: white; cursor: pointer; }
    button:hover { background: #1a1a1a; color: white; border-color: #1a1a1a; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .output { border: 1px solid #ddd; background: white; }
    .output-header { padding: 1rem; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; font-family: monospace; font-size: 0.8rem; color: #999; }
    .output-content { padding: 1rem; font-family: monospace; font-size: 0.8rem; min-height: 150px; max-height: 300px; overflow-y: auto; }
    .log { margin-bottom: 0.25rem; }
    .log-time { color: #999; }
    .log-success { color: green; }
    .log-error { color: red; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Agents</h1>
    <p class="subtitle">Autonomous task execution</p>
    <div class="agents" id="agents">
      <div class="agent">
        <div>
          <div class="agent-name">Penetration Tester</div>
          <div class="agent-desc">Scans for security vulnerabilities</div>
          <div class="agent-schedule">0 9 * * *</div>
        </div>
        <div class="buttons">
          <button onclick="logs('pentest')">Logs</button>
          <button onclick="run('pentest')">Run</button>
        </div>
      </div>
      <div class="agent">
        <div>
          <div class="agent-name">Bug Hunter</div>
          <div class="agent-desc">Analyzes code for bugs</div>
          <div class="agent-schedule">0 10 * * *</div>
        </div>
        <div class="buttons">
          <button onclick="logs('bughunter')">Logs</button>
          <button onclick="run('bughunter')">Run</button>
        </div>
      </div>
      <div class="agent">
        <div>
          <div class="agent-name">Data Insights</div>
          <div class="agent-desc">Surfaces actionable insights</div>
          <div class="agent-schedule">0 11 * * 1</div>
        </div>
        <div class="buttons">
          <button onclick="logs('datainsights')">Logs</button>
          <button onclick="run('datainsights')">Run</button>
        </div>
      </div>
      <div class="agent">
        <div>
          <div class="agent-name">Feedback Analyzer</div>
          <div class="agent-desc">Identifies pain points from user feedback</div>
          <div class="agent-schedule">0 12 * * 1</div>
        </div>
        <div class="buttons">
          <button onclick="logs('feedback')">Logs</button>
          <button onclick="run('feedback')">Run</button>
        </div>
      </div>
      <div class="agent">
        <div>
          <div class="agent-name">Skeptical Investor</div>
          <div class="agent-desc">Challenges assumptions</div>
          <div class="agent-schedule">0 14 * * 5</div>
        </div>
        <div class="buttons">
          <button onclick="logs('investor')">Logs</button>
          <button onclick="run('investor')">Run</button>
        </div>
      </div>
      <div class="agent">
        <div>
          <div class="agent-name">KPI Analyzer</div>
          <div class="agent-desc">Tracks metrics week-over-week</div>
          <div class="agent-schedule">0 9 * * 1</div>
        </div>
        <div class="buttons">
          <button onclick="logs('kpi')">Logs</button>
          <button onclick="run('kpi')">Run</button>
        </div>
      </div>
    </div>
    <div class="output">
      <div class="output-header">
        <span>Output</span>
        <button onclick="clear()">Clear</button>
      </div>
      <div class="output-content" id="out"></div>
    </div>
  </div>
  <script>
    function log(msg, cls) {
      var o = document.getElementById('out');
      var t = new Date().toTimeString().slice(0,8);
      o.innerHTML += '<div class="log"><span class="log-time">' + t + '</span> <span class="' + (cls||'') + '">' + msg + '</span></div>';
      o.scrollTop = o.scrollHeight;
    }
    function clear() { document.getElementById('out').innerHTML = ''; }
    function run(id) {
      log('Starting ' + id + '...');
      fetch('/api/agents/' + id + '/warm', {method:'POST'}).catch(function(){});
      setTimeout(function() { doRun(id, 0); }, 2000);
    }
    function doRun(id, n) {
      fetch('/api/agents/' + id + '/run', {method:'POST'})
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.success) {
            log(id + ' completed', 'log-success');
            if (d.output) log(d.output);
          } else if (d.error && d.error.indexOf('blockConcurrency') > -1 && n < 3) {
            log('Container starting, retry ' + (n+2) + '/4...');
            setTimeout(function() { doRun(id, n+1); }, 10000);
          } else {
            log('Error: ' + d.error, 'log-error');
          }
        })
        .catch(function(e) {
          if (n < 3) {
            log('Retrying ' + (n+2) + '/4...');
            setTimeout(function() { doRun(id, n+1); }, 10000);
          } else {
            log('Error: ' + e.message, 'log-error');
          }
        });
    }
    function logs(id) {
      log('Fetching logs for ' + id + '...');
      fetch('/api/agents/' + id + '/logs')
        .then(function(r) { return r.json(); })
        .then(function(d) { log(d.logs || 'No logs'); })
        .catch(function(e) { log('Error: ' + e.message, 'log-error'); });
    }
  </script>
</body>
</html>
`;