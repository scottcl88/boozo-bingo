// Runs the real-socket end-to-end suites against a freshly started server on a free port.
// Usage: npm test   (exit code is non-zero if the server fails to start or ANY suite fails)
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const SUITES = ['e2e.js', 'persistence.js'];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function waitForHttp(url, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get(url, (res) => { res.resume(); res.statusCode < 500 ? resolve() : retry(); }).on('error', retry);
      function retry() { Date.now() > deadline ? reject(new Error('server did not become ready: ' + url)) : setTimeout(poll, 150); }
    })();
  });
}

function runSuite(file, base) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], { env: { ...process.env, BASE: base }, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'] });
  let serverExited = false;
  server.on('exit', () => { serverExited = true; });
  let ok = true;
  try {
    await waitForHttp(base + '/', 15000);
    for (const suite of SUITES) {
      console.log(`\n=== ${suite} ===`);
      if (!(await runSuite(suite, base))) { ok = false; console.error(`FAILED: ${suite}`); }
    }
  } catch (err) {
    ok = false;
    console.error('FATAL', err.message, serverExited ? '(server exited early)' : '');
  } finally {
    server.kill();
  }
  console.log(ok ? '\nALL SUITES PASSED' : '\nSUITES FAILED');
  process.exit(ok ? 0 : 1);
})();
