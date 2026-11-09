const crypto = require('node:crypto');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

function problem(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function random() {
  return crypto.randomBytes(32).toString('base64url');
}

function scopesOf(tokens) {
  return typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : [];
}

// This module never reads credentials from another application or stores tokens on disk.
function createChatGPT({ fetchImpl = fetch, now = Date.now } = {}) {
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(90000) });
    } catch {
      throw problem('Could not reach OpenAI. Check your internet connection and try again.');
    }
    if (!response.ok) {
      // Do not expose token endpoint bodies, tokens, or authorization codes.
      const message = response.status === 429
        ? 'Your ChatGPT usage limit was reached. Check your plan usage or try again later.'
        : response.status === 401
          ? 'Your ChatGPT session has expired. Disconnect and sign in again.'
          : response.status === 403
            ? 'Your account or workspace does not allow this request. Check plan permissions.'
            : 'OpenAI could not complete this request. Please try signing in again.';
      throw problem(message, response.status === 429 ? 429 : 502);
    }
    return response;
  }

  function begin(session, redirectUri, hostId) {
    const verifier = random();
    const attempt = {
      state: random(), nonce: random(), verifier, redirectUri,
      createdAt: now(), clientId: session.connection?.clientId || null,
    };
    session.attempt = attempt;
    const query = new URLSearchParams({
      client_id: attempt.clientId || 'dynamic_agent_client',
      ext_agent_host_id: hostId,
      response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    });
    if (!attempt.clientId) query.set('agent_name_hint', 'AI Travel WingMan');
    if (session.connection?.idToken) query.set('id_token_hint', session.connection.idToken);
    return `${ISSUER}/api/accounts/authorize?${query}`;
  }

  async function validateIdToken(token, clientId, nonce) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (!['RS256', 'ES256'].includes(header.alg) || !header.kid) throw new Error();
      const jwks = await (await request(`${ISSUER}/.well-known/jwks.json`)).json();
      const jwk = jwks.keys?.find(key => key.kid === header.kid
        && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
      if (!jwk) throw new Error();
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const verified = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
        header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
        Buffer.from(parts[2], 'base64url'));
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!verified || claims.iss !== ISSUER || !audience.includes(clientId)
        || (audience.length > 1 && claims.azp !== clientId)
        || (claims.azp && claims.azp !== clientId)
        || !Number.isFinite(claims.exp) || claims.exp <= now() / 1000
        || (claims.nbf && claims.nbf > now() / 1000 + 30)
        || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) {
        throw new Error();
      }
      return claims;
    } catch {
      throw problem('Could not verify the ChatGPT sign-in. Please start sign-in again.', 400);
    }
  }

  async function finish(session, params) {
    const attempt = session.attempt;
    const state = params.get('state');
    if (!attempt || !state || state !== attempt.state || now() - attempt.createdAt > 10 * 60000) {
      throw problem('This sign-in link is invalid or expired. Please start sign-in again.', 400);
    }
    delete session.attempt; // Each callback can be exchanged only once.
    if (params.has('error')) throw problem('ChatGPT sign-in was cancelled or unavailable. You can try again.', 400);
    const code = params.get('code');
    const clientId = params.get('client_id') || attempt.clientId;
    if (!code || !clientId || clientId === 'dynamic_agent_client'
      || (attempt.clientId && clientId !== attempt.clientId)) {
      throw problem('ChatGPT registration was incomplete. Please start sign-in again.', 400);
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE,
    });
    const tokens = await (await request(`${ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    })).json();
    const claims = await validateIdToken(tokens.id_token, clientId, attempt.nonce);
    if (session.connection && session.connection.subject !== claims.sub) {
      throw problem('A different account was returned. Disconnect before switching accounts.', 400);
    }
    if (typeof tokens.access_token !== 'string' || tokens.token_type?.toLowerCase() !== 'bearer'
      || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      throw problem('ChatGPT did not return a usable connection. Please sign in again.');
    }
    session.connection = {
      clientId, subject: claims.sub, email: claims.email || '', idToken: tokens.id_token,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: now() + tokens.expires_in * 1000,
      earliestRefreshAt: tokens.earliest_refresh_at,
      scopes: scopesOf(tokens),
    };
  }

  function status(session) {
    const connection = session?.connection;
    return {
      connected: Boolean(connection),
      planEnabled: Boolean(connection?.scopes.includes('chatgpt.tokens.use.direct')
        && connection.scopes.includes('resource.invoke')),
      email: connection?.email || '',
      error: session?.authError || '',
    };
  }

  async function accessToken(connection) {
    if (connection.expiresAt > now() + 30000) return connection.accessToken;
    if (!connection.refreshToken) throw problem('Please disconnect and sign in to ChatGPT again.', 401);
    if (!connection.refreshing) {
      connection.refreshing = (async () => {
        const tokens = await (await request(`${ISSUER}/api/accounts/oauth/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.clientId,
            refresh_token: connection.refreshToken, resource: RESOURCE }),
        })).json();
        if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in)) {
          throw problem('Please disconnect and sign in to ChatGPT again.', 401);
        }
        Object.assign(connection, {
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
          expiresAt: now() + tokens.expires_in * 1000,
          ...(typeof tokens.scope === 'string' ? { scopes: scopesOf(tokens) } : {}),
        });
      })().finally(() => { delete connection.refreshing; });
    }
    await connection.refreshing;
    return connection.accessToken;
  }

  async function suggest(session, message) {
    if (!status(session).planEnabled) throw problem('ChatGPT plan usage was not authorized. Disconnect and sign in with an eligible account.', 403);
    const connection = session.connection;
    const token = await accessToken(connection);
    if (!status(session).planEnabled) throw problem('ChatGPT plan usage is no longer authorized. Please sign in again.', 403);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const catalog = await (await request(`${RESOURCE}/models`, { headers })).json();
    const models = catalog.models?.filter(model => model.visibility === 'list' && typeof model.slug === 'string') || [];
    const selected = process.env.CHATGPT_MODEL
      ? models.find(model => model.slug === process.env.CHATGPT_MODEL) : models[0];
    if (!selected) throw problem('No suitable model is available for this ChatGPT account. Check your account permissions.', 403);
    const response = await request(`${RESOURCE}/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: selected.slug, store: false, stream: true,
        instructions: 'You are AI Travel WingMan. Reply in English. Suggest a practical day-by-day itinerary matching the destination, dates, and total USD budget. Label costs as estimates. You have no live web search in this app: do not claim current flight or hotel prices, weather forecasts, verified opening hours, or retrieved sources. Explain assumptions, flag missing information, and say when a budget may be unrealistic. Keep the answer concise and readable as plain text.',
        input: [{ role: 'user', content: message }],
      }),
    });
    let buffer = '';
    let reply = '';
    let completed = false;
    const decoder = new TextDecoder();
    function consume(block) {
      const data = block.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      if (event.type === 'response.output_text.delta') reply += event.delta || '';
      if (event.type === 'response.completed') completed = true;
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        throw problem('ChatGPT could not finish this request. Check your plan usage and try again.');
      }
    }
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
        }
        if (buffer.length + reply.length > 1000000) throw problem('The response was too large. Please try a shorter trip.');
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } catch (error) {
      if (error.status) throw error;
      throw problem('The ChatGPT response was interrupted. Please try again.');
    }
    if (!completed || !reply.trim()) throw problem('ChatGPT did not return a complete suggestion. Please try again.');
    return { mode: 'chatgpt', reply, model: selected.display_name || selected.slug };
  }

  return { begin, finish, status, suggest };
}

module.exports = { createChatGPT };
