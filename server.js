// Tiny local server: serves the ticker page and proxies GraphQL calls to
// monday.com's API so the browser never hits CORS restrictions.
// No npm install needed — only built-in Node modules.
//
// Run with:  node server.js
// Then open: http://localhost:4173

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/monday-api') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      const { token, query, variables } = parsed;
      if (!token || !query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'token and query are required' }));
      }
      const payload = JSON.stringify({ query, variables: variables || {} });
      const options = {
        hostname: 'api.monday.com',
        path: '/v2',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const proxyReq = https.request(options, proxyRes => {
        let data = '';
        proxyRes.on('data', c => { data += c; });
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode || 200, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      proxyReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      proxyReq.write(payload);
      proxyReq.end();
    });
    return;
  }

  // Static file serving
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  reqPath = reqPath.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, reqPath);

  // Prevent path traversal outside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`monday.com ticker running at http://localhost:${PORT}`);
});
