/**
 * google-helpers.js — Reusable wrappers around Google APIs
 *
 * Functions exported:
 *   getCalendarEvents(auth, calendarId, startDate, endDate)
 *   getGmailThreadsFromDomains(auth, domains, daysBack)
 *   getGmailThreadsFromDomain(auth, domain, maxResults)
 *   ensureDriveFolderExists(auth, folderName)
 *   saveGoogleDoc(auth, title, body, folderId)
 *   readGoogleDoc(auth, docUrl)
 */

'use strict';

const { google } = require('googleapis');

// ─── Calendar ────────────────────────────────────────────────────────────────

/**
 * Fetch calendar events between two ISO date strings.
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth
 * @param {string} calendarId  e.g. "primary"
 * @param {Date}   start
 * @param {Date}   end
 * @returns {Promise<Array>}   array of event resource objects
 */
async function getCalendarEvents(auth, calendarId, start, end) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });
  return res.data.items || [];
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

/**
 * Fetch recent Gmail threads whose sender matches any of the given domains.
 * Only returns emails from the last `daysBack` days.
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth
 * @param {string[]} domains   e.g. ["instacart.com", "stripe.com"]
 * @param {number}   daysBack  how many days back to search
 * @returns {Promise<Array>}   array of { subject, from, date, snippet, body }
 */
async function getGmailThreadsFromDomains(auth, domains, daysBack = 7) {
  const gmail = google.gmail({ version: 'v1', auth });

  // Build a query like: (from:@instacart.com OR from:@stripe.com) newer_than:7d
  const fromClauses = domains.map(d => `from:@${d}`).join(' OR ');
  const query = `(${fromClauses}) newer_than:${daysBack}d`;

  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const threads = listRes.data.threads || [];
  const results = [];

  for (const thread of threads) {
    try {
      const threadRes = await gmail.users.threads.get({
        userId: 'me',
        id: thread.id,
        format: 'full',
      });
      const msg = threadRes.data.messages?.[0];
      if (!msg) continue;

      const headers = msg.payload?.headers || [];
      const get = (name) =>
        headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      // Extract plain-text body (handles multipart messages)
      const body = extractPlainText(msg.payload);

      results.push({
        threadId: thread.id,
        subject:  get('Subject'),
        from:     get('From'),
        date:     get('Date'),
        snippet:  threadRes.data.messages?.slice(-1)[0]?.snippet || '',
        body:     body.slice(0, 2000), // cap to avoid huge context
      });
    } catch (err) {
      // Skip threads that can't be fetched (permissions, etc.)
      console.error(`  ⚠ Could not fetch thread ${thread.id}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Fetch Gmail threads from a single domain (used by prepare-agenda.js).
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth
 * @param {string} domain
 * @param {number} maxResults
 * @returns {Promise<Array>}
 */
async function getGmailThreadsFromDomain(auth, domain, maxResults = 20) {
  return getGmailThreadsFromDomains(auth, [domain], 30);
}

/**
 * Recursively extracts plain-text content from a Gmail message payload.
 */
function extractPlainText(payload) {
  if (!payload) return '';

  // Leaf node with plain text
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  // Recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  return '';
}

// ─── Google Drive / Docs ─────────────────────────────────────────────────────

/**
 * Ensures a Drive folder with the given name exists (creates if not found).
 * Returns the folder ID.
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth
 * @param {string} folderName
 * @returns {Promise<string>} folderId
 */
async function ensureDriveFolderExists(auth, folderName) {
  const drive = google.drive({ version: 'v3', auth });

  // Search for an existing folder with this name
  const searchRes = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (searchRes.data.files?.length > 0) {
    return searchRes.data.files[0].id;
  }

  // Create the folder
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  return createRes.data.id;
}

/**
 * Creates a new Google Doc with the given title and plain-text body,
 * places it inside the specified Drive folder, and returns the doc URL.
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth
 * @param {string} title
 * @param {string} bodyText   plain text content
 * @param {string} folderId
 * @returns {Promise<string>} URL to the new Google Doc
 */
async function saveGoogleDoc(auth, title, bodyText, folderId) {
  const drive = google.drive({ version: 'v3', auth });
  const docs  = google.docs({ version: 'v1', auth });

  // 1. Create an empty Google Doc
  const createRes = await drive.files.create({
    requestBody: {
      name:     title,
      mimeType: 'application/vnd.google-apps.document',
      parents:  [folderId],
    },
    fields: 'id',
  });
  const docId = createRes.data.id;

  // 2. Insert the text content via the Docs batchUpdate API
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: bodyText,
          },
        },
      ],
    },
  });

  return `https://docs.google.com/document/d/${docId}/edit`;
}

/**
 * Reads and returns the plain-text content of a Google Doc given its URL.
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth
 * @param {string} docUrl   full Google Doc URL
 * @returns {Promise<{ title: string, content: string }>}
 */
async function readGoogleDoc(auth, docUrl) {
  // Extract the document ID from the URL
  const match = docUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error(`Cannot parse Google Doc ID from URL: ${docUrl}`);
  const docId = match[1];

  const docs   = google.docs({ version: 'v1', auth });
  const docRes = await docs.documents.get({ documentId: docId });

  const title   = docRes.data.title || 'Untitled';
  const content = extractDocText(docRes.data.body?.content || []);

  return { title, content };
}

/**
 * Walks the Docs API structural elements and extracts plain text.
 */
function extractDocText(elements) {
  let text = '';
  for (const el of elements) {
    if (el.paragraph) {
      for (const run of el.paragraph.elements || []) {
        if (run.textRun?.content) text += run.textRun.content;
      }
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          text += extractDocText(cell.content || []);
        }
      }
    }
  }
  return text;
}

module.exports = {
  getCalendarEvents,
  getGmailThreadsFromDomains,
  getGmailThreadsFromDomain,
  ensureDriveFolderExists,
  saveGoogleDoc,
  readGoogleDoc,
};
