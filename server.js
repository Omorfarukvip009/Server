import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.OAUTH_REDIRECT_URI
);

// Load tokens
let tokens = {};
if (fs.existsSync(process.env.TOKEN_STORE)) {
  tokens = JSON.parse(fs.readFileSync(process.env.TOKEN_STORE));
}

// Generate auth URL
app.get('/auth/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  res.send(`<a href="${url}" target="_blank">Authorize Gmail</a>`);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const { tokens: newTokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(newTokens);
  // Save tokens
  fs.writeFileSync(process.env.TOKEN_STORE, JSON.stringify(newTokens, null, 2));
  res.send('Gmail authorized successfully!');
});

// Check if email is authenticated
app.post('/api/check-auth', async (req, res) => {
  const { email } = req.body;
  // Check if token exists for this email
  if (tokens.email === email) {
    return res.json({ authenticated: true });
  }
  return res.json({ authenticated: false });
});

// Get inbox messages (subjects only)
app.get('/api/messages', async (req, res) => {
  const email = req.query.email;
  if (!tokens.email || tokens.email !== email) {
    return res.status(401).json({ error: 'Email not authenticated' });
  }
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 20 });
    const messages = [];
    if (listRes.data.messages) {
      for (const msg of listRes.data.messages) {
        const m = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject'] });
        const subjectHeader = m.data.payload.headers.find(h => h.name === 'Subject');
        messages.push({
          id: msg.id,
          subject: subjectHeader ? subjectHeader.value : '(No Subject)',
        });
      }
    }
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 4000, () => console.log('Gmail backend running.'));
