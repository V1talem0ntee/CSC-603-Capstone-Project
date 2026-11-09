const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createChatGPT } = require('./chatgpt');

const port = Number(process.env.PORT || 3000);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        chunks.length = 0;
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (size > 16 * 1024) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createApp({ auth = createChatGPT(), hostId, appPort = port } = {}) {
  const origin = `http://127.0.0.1:${appPort}`;
  const sessions = new Map();
  const maxAge = 8 * 60 * 60 * 1000;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (![ `127.0.0.1:${appPort}`, `localhost:${appPort}` ].includes(req.headers.host)) {
      return sendJson(res, 400, { error: 'Use the local address printed by this server.' });
    }
    const url = new URL(req.url, origin);
    const pathname = url.pathname;
    if (req.headers.host.startsWith('localhost:')) {
      res.writeHead(303, { Location: `${origin}${url.pathname}${url.search}` });
      return res.end();
    }
    if (req.method === 'POST' && (req.headers['x-requested-with'] !== 'TravelWingMan'
      || (req.headers.origin && req.headers.origin !== origin))) {
      return sendJson(res, 403, { error: 'Please make this request from the local app.' });
    }
    for (const [id, value] of sessions) {
      if (Date.now() - value.lastUsed > maxAge) sessions.delete(id);
    }
    const cookie = (req.headers.cookie || '').split(';').map(value => value.trim())
      .find(value => value.startsWith('wingman_session='))?.slice('wingman_session='.length);
    let session = sessions.get(cookie);
    if (session) session.lastUsed = Date.now();
    function redirectHome() {
      res.writeHead(303, { Location: '/' });
      res.end();
    }
    if (req.method === 'GET' && pathname === '/api/auth/status') {
      return sendJson(res, 200, auth.status(session));
    }
    if (req.method === 'POST' && pathname === '/auth/chatgpt/start') {
      if (!session) {
        if (sessions.size >= 100) return sendJson(res, 429, { error: 'Too many sessions. Restart the local server.' });
        const id = crypto.randomBytes(32).toString('hex');
        session = { lastUsed: Date.now() };
        sessions.set(id, session);
        res.setHeader('Set-Cookie', `wingman_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
      }
      delete session.authError;
      return sendJson(res, 200, { url: auth.begin(session, `${origin}/auth/callback`, hostId) });
    }
    if (req.method === 'GET' && pathname === '/auth/callback') {
      if (!session) return sendJson(res, 400, { error: 'Your sign-in session expired. Return to the app and try again.' });
      try {
        await auth.finish(session, url.searchParams);
        delete session.authError;
      } catch (error) {
        session.authError = error.status ? error.message : 'Sign-in could not be completed. Please try again.';
      }
      return redirectHome();
    }
    if (req.method === 'POST' && pathname === '/auth/chatgpt/disconnect') {
      sessions.delete(cookie);
      res.setHeader('Set-Cookie', 'wingman_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return sendJson(res, 200, { connected: false });
    }
  // Only these public files are served; project files stay private.
  const publicFiles = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  };
  if (req.method === 'GET' && Object.hasOwn(publicFiles, pathname)) {
    const [filename, contentType] = publicFiles[pathname];
    try {
      const content = await fs.readFile(path.join(__dirname, 'public', filename));
      res.writeHead(200, { 'Content-Type': contentType });
      return res.end(content);
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: 'Could not load the frontend.' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', mode: auth.status(session).planEnabled ? 'chatgpt' : 'demo' });
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    try {
      const body = await readJson(req);
      const message = body?.message;
      if (typeof message !== 'string' || !message.trim()) {
        return sendJson(res, 400, { error: 'message must be a non-empty string.' });
      }

      if (auth.status(session).connected) {
        return sendJson(res, 200, await auth.suggest(session, message.trim()));
      }
      // Keep the original demo available before the user connects an account.
      return sendJson(res, 200, {
        mode: 'demo',
        reply: `Your trip details:\n${message.trim()}\n\nThis is a demo response. The backend connection is working. AI trip planning is not connected yet.`,
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: error.status ? error.message : 'Internal server error.',
      });
    }
  }

  return sendJson(res, 404, { error: 'Endpoint not found.' });
  };
}

async function start() {
  const directory = path.join(__dirname, '.local');
  const filename = path.join(directory, 'chatgpt-host-id');
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(filename, `urn:uuid:${crypto.randomUUID()}`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const hostId = (await fs.readFile(filename, 'utf8')).trim();
  const server = http.createServer(createApp({ hostId }));
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Travel WingMan: http://127.0.0.1:${server.address().port}`);
  });
  server.on('error', (error) => {
    console.error(`Could not start backend: ${error.message}`);
    process.exitCode = 1;
  });
}

if (require.main === module) start().catch(() => {
  console.error('Could not initialize the local server. Check file permissions and port settings.');
  process.exitCode = 1;
});

module.exports = { createApp };
