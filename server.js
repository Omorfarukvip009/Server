require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const cors = require('cors');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI, PORT = 4000, ACCESS_KEY = 'FRK', TOKEN_STORE = './tokens.json' } = process.env;
const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: true }));

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI);

function saveTokens(tokens) { fs.writeFileSync(TOKEN_STORE, JSON.stringify(tokens, null, 2)); }
function loadTokens() { if (!fs.existsSync(TOKEN_STORE)) return null; return JSON.parse(fs.readFileSync(TOKEN_STORE, 'utf8')); }
function checkAccessKey(req, res, next) { if ((req.get('x-access-key') || '').trim() !== ACCESS_KEY) return res.status(403).json({ error: 'Invalid access key' }); next(); }
async function ensureValidCredentials() { const tokens = loadTokens(); if (!tokens) throw new Error('No tokens. Visit /auth/url first.'); oauth2Client.setCredentials(tokens); oauth2Client.on && oauth2Client.on('tokens', (newTokens) => { const merged = Object.assign({}, tokens, newTokens); saveTokens(merged); }); return oauth2Client; }

app.get('/auth/url', (req, res) => { const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' }); res.json({ url }); });

app.get('/auth/callback', async (req, res) => { const code = req.query.code; if (!code) return res.status(400).send('Missing code'); try { const { tokens } = await oauth2Client.getToken(code); saveTokens(tokens); res.send('<h3>Gmail authorized successfully!</h3><p>Close this window and return to your app.</p>'); } catch (err) { console.error(err); res.status(500).send('Authorization failed'); } });

app.get('/api/messages', checkAccessKey, async (req, res) => { try { await ensureValidCredentials(); const gmail = google.gmail({ version: 'v1', auth: oauth2Client }); const listResp = await gmail.users.messages.list({ userId: 'me', labelIds: ['UNREAD'], maxResults: Math.min(parseInt(req.query.max || '10', 10), 50) }); const messages = listResp.data.messages || []; const out = []; for (const m of messages) { const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }); const headers = msg.data.payload?.headers || []; const headerMap = {}; headers.forEach(h => headerMap[h.name] = h.value); out.push({ id: m.id, subject: headerMap['Subject'] || '(no subject)', from: headerMap['From'] || '', date: headerMap['Date'] || '', snippet: msg.data.snippet || '' }); } res.json({ messages: out }); } catch (err) { console.error(err); res.status(500).json({ error: String(err.message || err) }); } });

app.get('/', (req, res) => res.send('Gmail hobby backend running.'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
