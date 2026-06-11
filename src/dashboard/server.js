import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = 3000;

// Ensure public directory exists
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// Map content types
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Helper to parse report metadata from markdown content
function parseReportMeta(filename, content) {
  let type = 'unknown';
  if (filename.startsWith('executive_qa_report')) type = 'executive';
  else if (filename.startsWith('content_report')) type = 'content';
  else if (filename.startsWith('navigation_report')) type = 'navigation';
  else if (filename.startsWith('security_report')) type = 'security';
  else if (filename.startsWith('ui_ux_report')) type = 'ui_ux';

  // Extract Date
  const dateMatch = content.match(/-\s+\*\*Date\*\*:\s*([^\n\r]+)/i);
  const dateStr = dateMatch ? dateMatch[1].trim() : 'Unknown Date';

  // Extract Target Site
  const targetMatch = content.match(/-\s+\*\*(Target Site|Target Host)\*\*:\s*([^\n\r]+)/i);
  let targetSite = targetMatch ? targetMatch[2].trim() : 'https://www.independentsponsor.news/';
  // Strip markdown links if any
  targetSite = targetSite.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Extract Bugs Count
  let bugsCount = 0;
  
  if (type === 'content') {
    const contentBugsMatch = content.match(/-\s+\*\*Content Mismatches Logged\*\*:\s*(\d+)/i);
    if (contentBugsMatch) bugsCount = parseInt(contentBugsMatch[1], 10);
  } else if (type === 'ui_ux') {
    const uiBugsMatch = content.match(/-\s+\*\*Bugs\/Observations Logged\*\*:\s*(\d+)/i);
    if (uiBugsMatch) bugsCount = parseInt(uiBugsMatch[1], 10);
  } else if (type === 'security') {
    const secBugsMatch = content.match(/-\s+\*\*Observations Logged\*\*:\s*(\d+)/i);
    if (secBugsMatch) bugsCount = parseInt(secBugsMatch[1], 10);
  } else if (type === 'navigation') {
    const brokenLinksMatch = content.match(/-\s+\*\*Broken Links Found\*\*\s*:\s*(\d+)/i);
    const consoleErrMatch = content.match(/-\s+\*\*Console Errors Logged\*\*\s*:\s*(\d+)/i);
    
    let navBugs = 0;
    if (brokenLinksMatch) navBugs += parseInt(brokenLinksMatch[1], 10);
    if (consoleErrMatch) navBugs += parseInt(consoleErrMatch[1], 10);
    bugsCount = navBugs;
  } else if (type === 'executive') {
    const healthErrors = content.match(/Broken Link Health Errors\*\*:\s*(?:✅\s*0|(\d+))/i);
    const uxIssues = content.match(/Visual\/UX Issues Logged\*\*:\s*(?:✅\s*0|(\d+))/i);
    const secIssues = content.match(/Security Audit Logs\*\*:\s*(?:✅\s*0|(\d+))/i);
    
    let execBugs = 0;
    if (healthErrors && healthErrors[1]) execBugs += parseInt(healthErrors[1], 10);
    if (uxIssues && uxIssues[1]) execBugs += parseInt(uxIssues[1], 10);
    if (secIssues && secIssues[1]) execBugs += parseInt(secIssues[1], 10);
    bugsCount = execBugs;
  }

  // Parse Timestamp from filename (Format: type_report_YYYY-MM-DDTHH-mm-ss-SSSZ.md)
  let timestamp = '';
  const tsMatch = filename.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)(Z)?\.md$/);
  if (tsMatch) {
    const [_, year, month, day, hour, min, sec, ms, z] = tsMatch;
    timestamp = `${year}-${month}-${day}T${hour}:${min}:${sec}.${ms}${z || ''}`;
  } else {
    // fallback to file system date
    try {
      const stats = fs.statSync(path.join(REPORTS_DIR, filename));
      timestamp = stats.mtime.toISOString();
    } catch (e) {
      timestamp = new Date().toISOString();
    }
  }

  return {
    filename,
    type,
    dateStr,
    targetSite,
    bugsCount,
    timestamp,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  // 1. API: List reports
  if (pathname === '/api/reports' && req.method === 'GET') {
    try {
      if (!fs.existsSync(REPORTS_DIR)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }

      const files = fs.readdirSync(REPORTS_DIR);
      const reports = [];

      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = path.join(REPORTS_DIR, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          reports.push(parseReportMeta(file, content));
        }
      }

      // Sort by timestamp descending (newest first)
      reports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reports));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read reports directory', details: error.message }));
    }
    return;
  }

  // 2. API: Get report content
  if (pathname.startsWith('/api/reports/') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.substring('/api/reports/'.length));
    
    // Safety check against path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }

    const filePath = path.join(REPORTS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Report not found' }));
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read report file', details: error.message }));
    }
    return;
  }

  // 3. API: Run Playwright test suite (SSE stream)
  if (pathname === '/api/run-test' && req.method === 'GET') {
    const suite = url.searchParams.get('suite');
    
    const validSuites = {
      'coordinated': 'tests/cross-agent.spec.ts',
      'content': 'tests/content-agent.spec.ts',
      'exploration': 'tests/exploration.spec.ts',
      'specialized': 'tests/specialized-agents.spec.ts',
      'user-journey': 'tests/user-journey.spec.ts',
      'auth': 'tests/auth.spec.ts',
    };

    if (!suite || !validSuites[suite]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing suite name' }));
      return;
    }

    const testFile = validSuites[suite];

    // Write SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (type, message, extra = {}) => {
      res.write(`data: ${JSON.stringify({ type, message, ...extra })}\n\n`);
    };

    sendEvent('start', `Spawning Playwright runner for: ${testFile}`);

    // Spawn Playwright
    // Set FORCE_COLOR=1 to capture raw ansi color sequences which we can render in terminal simulator!
    const env = { ...process.env, FORCE_COLOR: '1' };
    const playwrightProcess = spawn('npx', ['playwright', 'test', testFile], {
      cwd: PROJECT_ROOT,
      env,
    });

    playwrightProcess.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() !== '') {
          sendEvent('log', line);
        }
      }
    });

    playwrightProcess.stderr.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() !== '') {
          sendEvent('error', line);
        }
      }
    });

    playwrightProcess.on('close', (code) => {
      sendEvent('end', `Playwright completed with exit code ${code}`, { code });
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      console.log(`[SSE] Client closed connection for ${suite} run. Killing test run...`);
      playwrightProcess.kill();
    });

    return;
  }

  // 4. Static: Serving screenshots
  if (pathname.startsWith('/screenshots/')) {
    const filename = decodeURIComponent(pathname.substring('/screenshots/'.length));
    
    // Safety check against path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid screenshot file path');
      return;
    }

    const filePath = path.join(REPORTS_DIR, 'screenshots', filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Screenshot not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    return;
  }

  // 5. Static: Serving public assets
  let staticPath = pathname;
  if (pathname === '/') {
    staticPath = '/index.html';
  }

  const publicFilePath = path.join(PUBLIC_DIR, staticPath);
  
  // Verify it exists inside the PUBLIC_DIR to prevent directory traversal
  const relative = path.relative(PUBLIC_DIR, publicFilePath);
  const isSafe = relative && !relative.startsWith('..') && !path.isAbsolute(relative);

  if (isSafe && fs.existsSync(publicFilePath) && fs.statSync(publicFilePath).isFile()) {
    const ext = path.extname(publicFilePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(publicFilePath);
    stream.pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1><p>The page you requested does not exist.</p>');
  }
});

server.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`🚀 ISN QA Framework Dashboard running at:`);
  console.log(`   👉 http://localhost:${PORT}`);
  console.log(`========================================================`);
});
