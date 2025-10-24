addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// Max emails to fetch from Gmail
const MAX_EMAILS = 10;

// Replace with your authenticated Gmail
const AUTHENTICATED_EMAIL = "mdomorfarukgemini.1@gmail.com";

async function handleRequest(request) {
  const url = new URL(request.url);

  // -------------------------------
  // 1. Key check endpoint
  // -------------------------------
  if (url.pathname === '/check') {
    const email = url.searchParams.get('email');
    if (!email) return new Response(JSON.stringify({ authenticated: false }), { headers: { 'Content-Type': 'application/json' } });

    if (email === AUTHENTICATED_EMAIL) {
      return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Content-Type': 'application/json' } });
    } else {
      return new Response(JSON.stringify({ authenticated: false }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // -------------------------------
  // 2. Inbox fetching endpoint
  // -------------------------------
  if (url.pathname === '/inbox') {
    const email = url.searchParams.get('email');
    if (!email || email !== AUTHENTICATED_EMAIL) return new Response('Unauthorized', { status: 401 });

    // Get token from KV
    const tokenDataRaw = await GMAIL_TOKENS.get(AUTHENTICATED_EMAIL);
    if (!tokenDataRaw) return new Response('Token missing', { status: 500 });

    const tokenData = JSON.parse(tokenDataRaw);

    // Fetch messages
    const messagesRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_EMAILS}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const messagesJson = await messagesRes.json();
    if (!messagesJson.messages) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });

    // Get subjects
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
