// src/index.js
// Cloudflare Worker that handles Google OAuth and inbox fetching.
// Uses GMAIL_TOKENS KV to store per-email tokens: value = JSON.stringify(tokens)

const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_RESULTS = 10; // limit to 10 for safety

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/auth') return handleAuth(env);
      if (pathname === '/auth/callback') return handleCallback(request, env);
      if (pathname === '/inbox') return handleInbox(request, env);
      // root: show basic message
      return new Response('Gmail Worker is running. Use /auth to authenticate.', { status: 200 });
    } catch (err) {
      return new Response('Server error: ' + (err.message || err), { status: 500 });
    }
  }
};

// 1) redirect to Google OAuth consent page
function handleAuth(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return Response.redirect(authUrl, 302);
}

// 2) callback: exchange code -> tokens, fetch email, store tokens in KV
async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing code', { status: 400 });

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.REDIRECT_URI,
      grant_type: 'authorization_code'
    }).toString()
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) return new Response(JSON.stringify(tokenData), { status: 400 });

  // Use access token to get the email address
  const email = await fetchUserEmail(tokenData.access_token);
  if (!email) return new Response('Unable to fetch email', { status: 500 });

  // Save tokens in KV (key = email). Store tokens + when saved.
  const storeObj = {
    tokens: tokenData,
    savedAt: Date.now()
  };
  await env.GMAIL_TOKENS.put(email, JSON.stringify(storeObj));

  // Return a small HTML page that stores email in localStorage and redirects home
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Auth complete</title></head>
  <body>
    <script>
      localStorage.setItem('gmail_authenticated_email', ${JSON.stringify(email)});
      // redirect to root of your frontend (or close)
      window.location.href = '/';
    </script>
    Auth complete. Redirecting...
  </body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

// Helper: fetch email address using access token
async function fetchUserEmail(accessToken) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.emailAddress;
}

// 3) Inbox endpoint: /inbox?email=you@gmail.com  -> returns JSON array of subject strings (max 10)
async function handleInbox(request, env) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email');
  if (!email) return new Response(JSON.stringify({ error: 'email query required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const kvValue = await env.GMAIL_TOKENS.get(email);
  if (!kvValue) return new Response(JSON.stringify({ error: 'not_authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  let stored;
  try { stored = JSON.parse(kvValue); } catch (e) { return new Response(JSON.stringify({ error: 'invalid token data' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }

  let { tokens } = stored;
  // Ensure we have an access token; refresh if needed
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    return new Response(JSON.stringify({ error: 'no_tokens' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // If access token expired or invalid, try refresh flow
  let accessToken = tokens.access_token;
  // We will attempt to fetch messages; if 401, refresh token and retry
  const subjects = await tryFetchSubjects(accessToken, tokens.refresh_token, email, env);
  if (subjects === null) {
    return new Response(JSON.stringify({ error: 'failed_fetch' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (subjects === 'unauthenticated') {
    return new Response(JSON.stringify({ error: 'not_authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ messages: subjects }), { headers: { 'Content-Type': 'application/json' } });
}

// try to fetch and if 401 then refresh and retry
async function tryFetchSubjects(accessToken, refreshToken, email, env) {
  let subjects = await fetchSubjectsWithToken(accessToken);
  if (subjects === 'unauthorized' && refreshToken) {
    // attempt refresh
    const newTokens = await refreshAccessToken(refreshToken, env);
    if (!newTokens) return 'unauthenticated';
    // update KV
    const storeObj = { tokens: newTokens, savedAt: Date.now() };
    await env.GMAIL_TOKENS.put(email, JSON.stringify(storeObj));
    // try again
    subjects = await fetchSubjectsWithToken(newTokens.access_token);
    if (Array.isArray(subjects)) return subjects;
    return 'unauthenticated';
  }
  return Array.isArray(subjects) ? subjects : (subjects === 'unauthorized' ? 'unauthenticated' : null);
}

// fetch message subjects with a given access token
async function fetchSubjectsWithToken(accessToken) {
  if (!accessToken) return 'unauthorized';
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_RESULTS}`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (listRes.status === 401) return 'unauthorized';
  if (!listRes.ok) return null;
  const listJson = await listRes.json();
  const msgs = listJson.messages || [];
  const result = [];
  for (const m of msgs) {
    const detailsRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!detailsRes.ok) continue;
    const detailsJson = await detailsRes.json();
    const header = (detailsJson.payload && detailsJson.payload.headers || []).find(h => h.name === 'Subject');
    result.push(header ? header.value : '(No Subject)');
  }
  return result;
}

// refresh token
async function refreshAccessToken(refreshToken, env) {
  if (!refreshToken) return null;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!r.ok) return null;
  const jd = await r.json();
  // jd contains new access_token (and maybe expiry). Keep refresh_token if not included.
  // The saved object must have refresh_token as well. Caller should merge old refresh_token if absent.
  return {
    access_token: jd.access_token,
    expires_in: jd.expires_in,
    scope: jd.scope,
    token_type: jd.token_type,
    // Note: Google may not return refresh_token on refresh; keep old refresh token if missing.
    refresh_token: jd.refresh_token || refreshToken
  };
}
