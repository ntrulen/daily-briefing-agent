/**
 * auth.js — Google OAuth2 helper shared across all scripts
 *
 * On first run, opens a browser so the user can authorize the app and
 * pastes the resulting code into the terminal.  The token is then saved
 * to token.json so every subsequent run is fully automatic.
 *
 * Scopes requested:
 *   - Calendar (read)
 *   - Gmail (read)
 *   - Drive (read + write — needed to create Docs / folders)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline   = require('readline');

const CREDENTIALS_PATH = path.join(__dirname, 'oauth-credentials.json');
const TOKEN_PATH       = path.join(__dirname, 'token.json');

// All Google API scopes the agent needs
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive',           // create / read Docs
];

/**
 * Returns an authorised OAuth2 client.
 * If token.json already exists the token is loaded silently.
 * Otherwise a browser is opened and the user is prompted for the auth code.
 *
 * @returns {Promise<import('googleapis').Auth.OAuth2Client>}
 */
async function getAuthClient() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const { installed } = JSON.parse(raw);
  const { client_id, client_secret, redirect_uris } = installed;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]   // "http://localhost"
  );

  // ── Reuse saved token if it exists ──────────────────────────────────────
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);

    // Silently refresh if the access token is expiring soon
    oauth2Client.on('tokens', (newTokens) => {
      const merged = { ...token, ...newTokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });

    return oauth2Client;
  }

  // ── First-run: browser-based authorisation ───────────────────────────────
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',   // force refresh_token to be returned
  });

  console.log('\n── Google OAuth authorisation required ──────────────────────');
  console.log('Opening your browser to authorise the Daily Briefing Agent…\n');
  console.log('If the browser does not open automatically, visit this URL:\n');
  console.log(authUrl);
  console.log('\n─────────────────────────────────────────────────────────────\n');

  // Try to open the browser automatically (best-effort)
  try {
    const open = require('open');
    await open(authUrl);
  } catch (_) { /* ignore — user will copy the URL manually */ }

  const code = await promptUser('Paste the authorisation code here: ');
  const { tokens } = await oauth2Client.getToken(code.trim());
  oauth2Client.setCredentials(tokens);

  // Persist the token for future runs
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\n✓ Token saved to ${TOKEN_PATH}\n`);

  return oauth2Client;
}

/** Prompts the user for input from stdin and returns the trimmed string. */
function promptUser(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

module.exports = { getAuthClient };
