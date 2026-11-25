// Local preview: node dev-server.mjs  ->  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const routes = {};
for (const f of fs.readdirSync('api')) routes['/api/' + f.replace(/\.js$/, '')] = (await import('./api/' + f)).default;

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (routes[p]) { try { return await routes[p](req, res); } catch (e) { console.error(e); res.statusCode = 500; return res.end('error'); } }
  let file = path.join('public', p === '/' ? 'index.html' : p);
  if (!path.extname(file)) file += '.html';
  if (!file.startsWith('public') || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
