const { execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const PORT = 8000;
const PUBLIC = path.join(__dirname, 'public');

// --- initial build ---
console.log('Building...');
execSync('node build.js', { stdio: 'inherit' });

// --- static file server ---
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const filePath = path.join(PUBLIC, urlPath);
  const ext = path.extname(filePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Serving at http://localhost:${PORT}`);
  console.log('Watching for changes...\n');
});

// --- watch & rebuild ---
chokidar.watch(['content', 'static', 'build.js'], { ignoreInitial: true })
  .on('all', (event, filePath) => {
    console.log(`${event}: ${filePath} — rebuilding...`);
    try {
      execSync('node build.js', { stdio: 'inherit' });
      console.log('Done. Refresh your browser.\n');
    } catch {
      console.error('Build failed.\n');
    }
  });
