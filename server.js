const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 4000;
const WORKSPACE = '/workspace';

// Store active sessions
const sessions = new Map();

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

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', workspace: WORKSPACE }));
    return;
  }

  // Run Claude Code
  if (url.pathname === '/run' && req.method === 'POST') {
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
        
        // Ensure directory exists
        if (!fs.existsSync(cwd)) {
          fs.mkdirSync(cwd, { recursive: true });
        }

        // Run Claude Code
        const env = { ...process.env };
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

        const claude = spawn('claude', [
          '--dangerously-skip-permissions',
          '--output-format', 'json',
          '-p', prompt
        ], {
          cwd,
          env,
          timeout: 300000 // 5 minute timeout
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

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`Claude Code container server running on port ${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
});
