/**
 * mcp-server.js — Daily Briefing MCP Server
 *
 * Exposes the three daily-briefing capabilities as MCP tools so they can be
 * invoked directly from the Claude desktop app without opening a terminal.
 *
 * Tools:
 *   get_daily_briefing       — full morning briefing (calendar + email → Claude → Drive)
 *   prepare_meeting_agenda   — agenda prep for a named meeting or company
 *   process_meeting_notes    — structured follow-up from a Google Doc of raw notes
 *
 * Run as a stdio MCP server. Add to Claude desktop's MCP config (~/.claude/mcp.json):
 *
 *   {
 *     "mcpServers": {
 *       "daily-briefing": {
 *         "command": "node",
 *         "args": ["/Users/nathantrulen/Desktop/daily-briefing-agent/mcp-server.js"]
 *       }
 *     }
 *   }
 *
 * All Google OAuth and API key config is read from .env + oauth-credentials.json,
 * exactly as the standalone scripts do. token.json is reused across all tools.
 */

'use strict';

// ── Load environment variables first so every downstream module sees them ────
require('dotenv').config({ path: __dirname + '/.env', quiet: true });

// ── MCP SDK (CJS build) ───────────────────────────────────────────────────────
const { McpServer }        = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                = require('zod');

// ── Anthropic SDK ─────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');

// ── Shared helpers (reuse exactly — no logic duplication) ─────────────────────
const { getAuthClient } = require('./auth');
const {
  getCalendarEvents,
  getGmailThreadsFromDomains,
  getGmailThreadsFromDomain,
  ensureDriveFolderExists,
  saveGoogleDoc,
  readGoogleDoc,
} = require('./google-helpers');

// ─── Config ───────────────────────────────────────────────────────────────────

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Companies tracked for the morning email scan (same list as daily-briefing.js)
const TRACKED_DOMAINS = [
  'instacart.com', 'target.com', 'generalmills.com', 'airbnb.com',
  'nash.ai', 'glean.com', 'amazon.com', 'gofundme.com', 'headway.com',
  'bestbuy.com', 'veeam.com', 'ramp.com', 'block.xyz', 'zillow.com',
  'shopify.com', 'stripe.com', 'asapp.com', '6sense.com',
  'outreach.io', 'teikametrics.com',
];

const DRIVE_FOLDER_NAME = 'Daily Briefings';

// ─── MCP Server instance ──────────────────────────────────────────────────────

const server = new McpServer({
  name:    'daily-briefing',
  version: '1.0.0',
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 1 — get_daily_briefing
// Mirrors the full daily-briefing.js pipeline.
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'get_daily_briefing',

  // Description shown to Claude so it knows when to invoke this tool
  'Run the full morning briefing pipeline: reads today\'s and tomorrow\'s Google '
  + 'Calendar events, scans Gmail for emails from tracked company domains (last 7 days), '
  + 'asks Claude to synthesise a structured briefing, then saves the result as a Google '
  + 'Doc in the "Daily Briefings" Drive folder. Returns the briefing text.',

  // No parameters needed — the tool self-contained
  {},

  async () => {
    try {
      // 1. Authenticate
      const auth = await getAuthClient();

      // 2. Build time windows
      const todayStart    = startOfDay(new Date());
      const todayEnd      = endOfDay(new Date());
      const tomorrow      = new Date(todayStart);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStart = startOfDay(tomorrow);
      const tomorrowEnd   = endOfDay(tomorrow);

      // 3. Fetch calendar and email data in parallel
      const [todayEvents, tomorrowEvents, emailThreads] = await Promise.all([
        getCalendarEvents(auth, CALENDAR_ID, todayStart, todayEnd),
        getCalendarEvents(auth, CALENDAR_ID, tomorrowStart, tomorrowEnd),
        getGmailThreadsFromDomains(auth, TRACKED_DOMAINS, 7),
      ]);

      // 4. Claude generates the briefing
      const briefing = await generateBriefing(todayEvents, tomorrowEvents, emailThreads);

      // 5. Save to Google Drive
      const folderId = await ensureDriveFolderExists(auth, DRIVE_FOLDER_NAME);
      const docTitle = `Daily Briefing — ${formatDateTitle(new Date())}`;
      const docUrl   = await saveGoogleDoc(auth, docTitle, briefing, folderId);

      // 6. Return briefing text + Drive link to Claude
      return {
        content: [{
          type: 'text',
          text: briefing + `\n\n---\n📄 Saved to Google Drive: ${docUrl}`,
        }],
      };
    } catch (err) {
      return errorResult('get_daily_briefing', err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 2 — prepare_meeting_agenda
// Mirrors the prepare-agenda.js pipeline.
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'prepare_meeting_agenda',

  'Look up an upcoming calendar event by company name or meeting title, pull recent '
  + 'Gmail threads from that company\'s domain, then ask Claude to generate a structured '
  + 'meeting agenda (objectives, talking points, questions, email context, prep checklist). '
  + 'Saves the agenda as a Google Doc and returns the text.',

  // Single required parameter
  {
    meeting_name: z.string().describe(
      'The company name or meeting title to search for in the next 14 days of calendar events.'
    ),
  },

  async ({ meeting_name }) => {
    try {
      const auth = await getAuthClient();

      // Search the next 14 days for a matching event
      const searchStart = new Date();
      const searchEnd   = new Date();
      searchEnd.setDate(searchEnd.getDate() + 14);

      const events = await getCalendarEvents(auth, CALENDAR_ID, searchStart, searchEnd);
      const match  = findBestMatch(events, meeting_name);

      if (!match) {
        return {
          content: [{
            type: 'text',
            text: `No upcoming event matching "${meeting_name}" found in the next 14 days. `
                + 'Try a different keyword — the search checks event titles and attendee email addresses.',
          }],
        };
      }

      // Derive the company domain from external attendees
      const domain       = extractDomainFromEvent(match);
      const emailThreads = domain
        ? await getGmailThreadsFromDomain(auth, domain, 20)
        : [];

      // Claude writes the agenda
      const agenda = await generateAgenda(match, emailThreads, meeting_name);

      // Save to Drive
      const folderId = await ensureDriveFolderExists(auth, DRIVE_FOLDER_NAME);
      const docTitle = `Agenda — ${match.summary} — ${formatDateTitle(new Date())}`;
      const docUrl   = await saveGoogleDoc(auth, docTitle, agenda, folderId);

      return {
        content: [{
          type: 'text',
          text: agenda + `\n\n---\n📄 Saved to Google Drive: ${docUrl}`,
        }],
      };
    } catch (err) {
      return errorResult('prepare_meeting_agenda', err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 3 — process_meeting_notes
// Mirrors the process-notes.js pipeline.
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  'process_meeting_notes',

  'Read a Google Doc containing raw meeting notes, then ask Claude to extract: '
  + 'action items with owners and suggested due dates, key decisions made, open questions, '
  + 'and a draft follow-up email. Saves the structured output as a new Google Doc and returns the text.',

  {
    doc_url: z.string().url().describe(
      'The full URL of the Google Doc containing the meeting notes, '
      + 'e.g. "https://docs.google.com/document/d/.../edit".'
    ),
  },

  async ({ doc_url }) => {
    try {
      const auth = await getAuthClient();

      // Read the source document
      const { title, content } = await readGoogleDoc(auth, doc_url);

      if (!content.trim()) {
        return {
          content: [{
            type: 'text',
            text: `The document "${title}" appears to be empty. `
                + 'Please add your meeting notes to the Doc and try again.',
          }],
        };
      }

      // Claude extracts structured follow-up content
      const followUp = await processMeetingNotes(title, content);

      // Save the follow-up doc to Drive
      const folderId = await ensureDriveFolderExists(auth, DRIVE_FOLDER_NAME);
      const docTitle = `Follow-Up — ${title} — ${formatDateTitle(new Date())}`;
      const docUrl2  = await saveGoogleDoc(auth, docTitle, followUp, folderId);

      return {
        content: [{
          type: 'text',
          text: followUp + `\n\n---\n📄 Saved to Google Drive: ${docUrl2}`,
        }],
      };
    } catch (err) {
      return errorResult('process_meeting_notes', err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Claude API calls — one function per tool, mirroring the standalone scripts
// ─────────────────────────────────────────────────────────────────────────────

/** Generates a morning briefing from calendar and email data. */
async function generateBriefing(todayEvents, tomorrowEvents, emailThreads) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const calendarSection = formatCalendarForPrompt(todayEvents, tomorrowEvents);
  const emailSection    = formatEmailsForPrompt(emailThreads);

  const message = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are a professional executive assistant writing a morning briefing.

Here is today's calendar data:
${calendarSection}

Here are recent emails from tracked companies (last 7 days):
${emailSection}

Please write a clean, well-structured morning briefing with these sections:

1. **TODAY'S SCHEDULE** — List each meeting with time, title, and 1-2 sentences of relevant context or preparation tips where useful.

2. **TOMORROW'S PREVIEW** — Brief summary of what's coming up tomorrow.

3. **EMAIL FLAGS** — Highlight any emails from tracked companies that need attention, with a one-line summary of what action (if any) is needed.

4. **PRIORITY ACTION** — Identify the single most important thing to accomplish today.

Keep the tone professional but readable. Use markdown formatting. Be concise — the reader is busy.`,
    }],
  });

  return message.content[0].text;
}

/** Generates a structured agenda for a calendar event. */
async function generateAgenda(event, emailThreads, originalQuery) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const eventDetails = formatEventDetails(event);
  const emailSection = emailThreads.length > 0
    ? emailThreads.map(t =>
        `From: ${t.from}\nDate: ${t.date}\nSubject: ${t.subject}\nSnippet: ${t.snippet}\n${t.body}`
      ).join('\n\n---\n\n')
    : 'No recent email history found for this company.';

  const message = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an executive assistant helping prepare for a meeting.

Meeting details:
${eventDetails}

Recent email history with this company/contact:
${emailSection}

Please generate a structured meeting agenda with these sections:

1. **MEETING OVERVIEW** — One paragraph summarising what this meeting is likely about.

2. **OBJECTIVES** — Bullet list of 2-4 clear goals for the meeting.

3. **TALKING POINTS** — Key topics to cover, in priority order.

4. **QUESTIONS TO ASK** — 3-5 smart, specific questions to ask the other party.

5. **RELEVANT CONTEXT FROM EMAILS** — Key insights or open threads from past email exchanges relevant to this meeting.

6. **PREP CHECKLIST** — Short list of anything to prepare or bring.

Keep it actionable, concise, and professional.`,
    }],
  });

  return message.content[0].text;
}

/** Extracts structured follow-up content from raw meeting notes. */
async function processMeetingNotes(docTitle, rawNotes) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a professional executive assistant processing raw meeting notes.

Document title: "${docTitle}"

Raw meeting notes:
---
${rawNotes}
---

Please extract and structure the following:

1. **ACTION ITEMS**
   For each action item, provide:
   - Task description
   - Owner (infer from context if not explicit)
   - Suggested due date

2. **KEY DECISIONS MADE**
   Bullet list of concrete decisions reached during the meeting.

3. **OPEN QUESTIONS / PARKING LOT**
   Items raised but not resolved, needing follow-up or deferred.

4. **DRAFT FOLLOW-UP EMAIL**
   A professional follow-up email with a clear subject line that recaps decisions and lists action items with owners.

Format the output cleanly with headers and bullet points. Be specific and actionable.`,
    }],
  });

  return message.content[0].text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared formatting and utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatCalendarForPrompt(todayEvents, tomorrowEvents) {
  const fmt = (events, label) => {
    if (events.length === 0) return `${label}: No events`;
    const lines = events.map(e => {
      const start = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'All day';
      const end = e.end?.dateTime
        ? new Date(e.end.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      const time      = end ? `${start}–${end}` : start;
      const attendees = (e.attendees || []).map(a => a.email).join(', ');
      return `  - ${time}: ${e.summary || 'Untitled'}`
        + (e.description ? `\n    Description: ${e.description.slice(0, 200)}` : '')
        + (attendees      ? `\n    Attendees: ${attendees}` : '');
    });
    return `${label}:\n${lines.join('\n')}`;
  };
  return `${fmt(todayEvents, 'TODAY')}\n\n${fmt(tomorrowEvents, 'TOMORROW')}`;
}

function formatEmailsForPrompt(threads) {
  if (threads.length === 0) return 'No emails from tracked companies in the last 7 days.';
  return threads.map(t =>
    `From: ${t.from}\nDate: ${t.date}\nSubject: ${t.subject}\nSnippet: ${t.snippet}`
  ).join('\n\n---\n\n');
}

function formatEventDetails(event) {
  const time      = formatEventTime(event);
  const attendees = (event.attendees || []).map(a => a.email).join(', ');
  const desc      = event.description ? `\nDescription: ${event.description.slice(0, 500)}` : '';
  return `Title: ${event.summary}\nTime: ${time}`
    + (attendees ? `\nAttendees: ${attendees}` : '')
    + desc;
}

function formatEventTime(event) {
  if (event.start?.dateTime) {
    const start = new Date(event.start.dateTime);
    const end   = event.end?.dateTime ? new Date(event.end.dateTime) : null;
    const opts  = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return end
      ? `${start.toLocaleString('en-US', opts)} – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : start.toLocaleString('en-US', opts);
  }
  return event.start?.date || 'All day';
}

/**
 * Finds the calendar event whose title best matches the search query.
 * Falls back to matching attendee email addresses.
 */
function findBestMatch(events, query) {
  const q = query.toLowerCase();
  return (
    events.find(e => e.summary?.toLowerCase().includes(q)) ||
    events.find(e => (e.attendees || []).some(a => a.email?.toLowerCase().includes(q))) ||
    null
  );
}

/**
 * Extracts the first non-gmail.com domain from a calendar event's attendee list.
 * Used to determine which company domain to search Gmail for.
 */
function extractDomainFromEvent(event) {
  for (const a of event.attendees || []) {
    if (!a.email) continue;
    const domain = a.email.split('@')[1];
    if (domain && domain !== 'gmail.com') return domain;
  }
  return null;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatDateTitle(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/** Returns a standardised MCP error result so the tool never throws to the host. */
function errorResult(toolName, err) {
  const msg = err?.message || String(err);
  // Log to stderr so it appears in Claude desktop's MCP logs, not in tool output
  process.stderr.write(`[daily-briefing/${toolName}] ERROR: ${msg}\n`);
  return {
    content: [{
      type: 'text',
      text: `Error running ${toolName}: ${msg}\n\nCheck the MCP server logs for details.`,
    }],
    isError: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Start — connect the server to stdio transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StdioServerTransport reads JSON-RPC messages from stdin and writes responses
 * to stdout. This is what Claude desktop expects when you configure an MCP
 * server with "command": "node".
 *
 * IMPORTANT: Nothing else should write to stdout after this point, or the
 * JSON-RPC framing will break. All diagnostic output goes to stderr.
 */
async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[daily-briefing] MCP server running on stdio\n');
}

start().catch(err => {
  process.stderr.write(`[daily-briefing] Fatal startup error: ${err.message}\n`);
  process.exit(1);
});
