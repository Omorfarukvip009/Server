addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const MAX_EMAILS = 10;
const AUTH_EMAIL = "mdomorfarukgemini.1@gmail.com"; // your single Gmail

async function handleRequest(request) {
  const url = new URL(request.url);

  // Check key
  if(url.pathname === '/check'){
    const email = url.searchParams.get('email');
    const token = await GMAIL_TOKENS.get(email);
    return new Response(JSON.stringify({ authenticated: !!token }), { headers: { 'Content-Type':'application/json' } });
  }

  // Inbox fetch
  if(url.pathname === '/inbox'){
    const email = url.searchParams.get('email');
    if(!email) return new Response('Email required', {status:400});
    const tokenDataRaw = await GMAIL_TOKENS.get(email);
    if(!tokenDataRaw) return new Response('Unauthorized', {status:401});
    const tokenData = JSON.parse(tokenDataRaw);

    const messagesRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_EMAILS}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const messagesJson = await messagesRes.json();
    const inbox = [];

    if(messagesJson.messages){
      for(let msg of messagesJson.messages){
        const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject`,{
          headers:{Authorization:`Bearer ${tokenData.access_token}`}
        });
        const mJson = await mRes.json();
        const subjectHeader = mJson.payload.headers.find(h=>h.name==='Subject');
        inbox.push(subjectHeader ? subjectHeader.value : '(No Subject)');
      }
    }

    return new Response(JSON.stringify({ messages: inbox }), { headers: { 'Content-Type':'application/json' } });
  }

  return new Response('Not found',{status:404});
}
