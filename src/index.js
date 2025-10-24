addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CLIENT_ID = GMAIL_CLIENT_ID;      // from wrangler.toml
const CLIENT_SECRET = GMAIL_CLIENT_SECRET;
const REDIRECT_URI = REDIRECT_URI;      // from wrangler.toml
const MAX_EMAILS = 10;

async function handleRequest(request) {
  const url = new URL(request.url);

  // 1. Check Gmail key from frontend
  if (url.pathname === '/check') {
    const email = url.searchParams.get('email');
    if (!email) return new Response(JSON.stringify({ authenticated: false }), { headers: { 'Content-Type': 'application/json' } });

    const tokenData = await GMAIL_TOKENS.get(email);
    if (tokenData) {
      return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Content-Type': 'application/json' } });
    } else {
      return new Response(JSON.stringify({ authenticated: false }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 2. Gmail OAuth Start
  if (url.pathname === '/auth') {
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES.join(' '))}&access_type=offline&prompt=consent`;
    return Response.redirect(authUrl, 302);
  }

  // 3. Gmail OAuth Callback
  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    if (!code) return new Response('Missing code', { status: 400 });

    // Exchange code for token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) return new Response('Token error', { status: 400 });

    // Get Gmail user email
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });
    const profile = await profileRes.json();
    const userEmail = profile.email;

    // Save token to KV
    await GMAIL_TOKENS.put(userEmail, JSON.stringify(tokenJson));

    return new Response(`Authentication successful for ${userEmail}. You can now use this Gmail as your key.`, { status: 200 });
  }

  // 4. Inbox fetching
  if (url.pathname === '/inbox') {
    const email = url.searchParams.get('email');
    if (!email) return new Response('Email required', { status: 400 });

    const tokenDataRaw = await GMAIL_TOKENS.get(email);
    if (!tokenDataRaw) return new Response('Unauthorized', { status: 401 });

    const tokenData = JSON.parse(tokenDataRaw);

    // Fetch messages
    const messagesRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_EMAILS}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const messagesJson = await messagesRes.json();
    if (!messagesJson.messages) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });

    const inbox = [];
    for (let msg of messagesJson.messages) {
      const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const mJson = await mRes.json();
      const subjectHeader = mJson.payload.headers.find(h => h.name === 'Subject');
      inbox.push(subjectHeader ? subjectHeader.value : '(No Subject)');
    }

    return new Response(JSON.stringify({ messages: inbox }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Not found', { status: 404 });
      }
