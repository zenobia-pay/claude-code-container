const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 4000;
const WORKSPACE = '/workspace';

// Store running tasks
const tasks = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check / ping - used by Cloudflare to check container is ready
  if (url.pathname === '/health' || url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', workspace: WORKSPACE, tasks: tasks.size }));
    return;
  }

  // Start a task (async - returns immediately with task ID)
  if (url.pathname === '/run' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt, workdir, apiKey, agentId } = JSON.parse(body);
        
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompt required' }));
          return;
        }

        const taskId = agentId || `task-${Date.now()}`;
        const cwd = workdir ? path.join(WORKSPACE, workdir) : WORKSPACE;
        
        // Ensure directory exists
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
        }

        // Create task entry
        tasks.set(taskId, {
          status: 'running',
          startTime: Date.now(),
          stdout: '',
          stderr: '',
          exitCode: null,
          cwd,
        });

        // Run Claude Code in background
        const env = { ...process.env };
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

        const claude = spawn('claude', [
          '--dangerously-skip-permissions',
          '--output-format', 'json',
          '-p', prompt
        ], {
          cwd,
          env,
          timeout: 600000 // 10 minute timeout
        });

        const task = tasks.get(taskId);

        claude.stdout.on('data', data => {
          task.stdout += data;
        });
        
        claude.stderr.on('data', data => {
          task.stderr += data;
        });

        claude.on('close', code => {
          task.status = code === 0 ? 'completed' : 'failed';
          task.exitCode = code;
          task.endTime = Date.now();
          
          // Parse result
          try {
            task.result = JSON.parse(task.stdout);
          } catch {
            task.result = { raw: task.stdout };
          }
        });

        claude.on('error', err => {
          task.status = 'failed';
          task.error = err.message;
          task.endTime = Date.now();
        });

        // Return task ID immediately
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          taskId, 
          status: 'running',
          message: 'Task started. Poll /status/{taskId} for results.'
        }));

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Check task status
  const statusMatch = url.pathname.match(/^\/status\/(.+)$/);
  if (statusMatch) {
    const taskId = statusMatch[1];
    const task = tasks.get(taskId);
    
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }

    const response = {
      taskId,
      status: task.status,
      startTime: task.startTime,
      elapsed: Date.now() - task.startTime,
    };

    if (task.status === 'completed' || task.status === 'failed') {
      response.endTime = task.endTime;
      response.exitCode = task.exitCode;
      response.result = task.result;
      response.stderr = task.stderr || undefined;
      response.error = task.error || undefined;
      
      // Clean up after retrieval
      tasks.delete(taskId);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // Run sync (for simple/quick tasks) - keeps old behavior
  if (url.pathname === '/run-sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt, workdir, apiKey } = JSON.parse(body);
        
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompt required' }));
          return;
        }

        const cwd = workdir ? path.join(WORKSPACE, workdir) : WORKSPACE;
        
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
        }

        const env = { ...process.env };
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

        const claude = spawn('claude', [
          '--dangerously-skip-permissions',
          '--output-format', 'json',
          '-p', prompt
        ], {
          cwd,
          env,
          timeout: 300000
        });

        let stdout = '';
        let stderr = '';

        claude.stdout.on('data', data => stdout += data);
        claude.stderr.on('data', data => stderr += data);

        claude.on('close', code => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          
          let result;
          try {
            result = JSON.parse(stdout);
          } catch {
            result = { raw: stdout };
          }

          res.end(JSON.stringify({
            exitCode: code,
            result,
            stderr: stderr || undefined,
            workdir: cwd
          }));
        });

        claude.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // List workspace files
  if (url.pathname === '/files') {
    const dir = url.searchParams.get('dir') || '';
    const targetDir = path.join(WORKSPACE, dir);
    
    try {
      const files = fs.readdirSync(targetDir, { withFileTypes: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        path: targetDir,
        files: files.map(f => ({
          name: f.name,
          type: f.isDirectory() ? 'directory' : 'file'
        }))
      }));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Read a file
  if (url.pathname === '/read') {
    const file = url.searchParams.get('file');
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file param required' }));
      return;
    }
    
    const filePath = path.join(WORKSPACE, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: filePath, content }));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Clone a repo
  if (url.pathname === '/clone' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { repo, dir } = JSON.parse(body);
        const targetDir = dir || repo.split('/').pop().replace('.git', '');
        const fullPath = path.join(WORKSPACE, targetDir);

        const git = spawn('git', ['clone', '--depth', '1', repo, fullPath]);
        
        let stderr = '';
        git.stderr.on('data', data => stderr += data);
        
        git.on('close', code => {
          res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: code === 0,
            path: fullPath,
            error: code !== 0 ? stderr : undefined
          }));
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // List all tasks
  if (url.pathname === '/tasks') {
    const taskList = [];
    for (const [id, task] of tasks) {
      taskList.push({
        taskId: id,
        status: task.status,
        startTime: task.startTime,
        elapsed: Date.now() - task.startTime,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: taskList }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`Claude Code container server running on port ${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
});
