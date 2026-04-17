#!/usr/bin/env node
/**
 * prepare-agenda.js — CAPABILITY 2: Meeting Agenda Prep
 *
 * Usage:
 *   node prepare-agenda.js "meeting name or company"
 *
 * What it does:
 *   1. Searches upcoming calendar events for one that matches the query
 *   2. Extracts the company domain from attendee emails
 *   3. Pulls recent Gmail threads from that domain
 *   4. Claude generates a structured meeting agenda
 *   5. Prints the agenda and saves it as a Google Doc in "Daily Briefings"
 */

'use strict';

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { getAuthClient } = require('./auth');
const {
  getCalendarEvents,
  getGmailThreadsFromDomain,
  ensureDriveFolderExists,
  saveGoogleDoc,
} = require('./google-helpers');

const CALENDAR_ID       = process.env.GOOGLE_CALENDAR_ID || 'primary';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRIVE_FOLDER_NAME = 'Daily Briefings';

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node prepare-agenda.js "meeting name or company"');
    process.exit(1);
  }

  console.log('━'.repeat(60));
  console.log(`  Agenda Prep: "${query}"`);
  console.log('━'.repeat(60));

  // ── 1. Authenticate ───────────────────────────────────────────────────────
  console.log('\n[1/5] Authenticating with Google…');
  const auth = await getAuthClient();
  console.log('      ✓ Authenticated');

  // ── 2. Find the matching calendar event ──────────────────────────────────
  console.log('\n[2/5] Searching for matching calendar event…');

  // Search the next 14 days for a matching event
  const searchStart = new Date();
  const searchEnd   = new Date();
  searchEnd.setDate(searchEnd.getDate() + 14);

  const events = await getCalendarEvents(auth, CALENDAR_ID, searchStart, searchEnd);
  const match  = findBestMatch(events, query);

  if (!match) {
    console.error(`\n✗ No upcoming event matching "${query}" found in the next 14 days.`);
    process.exit(1);
  }

  console.log(`      ✓ Found: "${match.summary}" on ${formatEventTime(match)}`);

  // ── 3. Determine company domain from attendees ────────────────────────────
  const domain = extractDomainFromEvent(match);
  console.log(`\n[3/5] Looking up emails${domain ? ` from ${domain}` : ''}…`);

  let emailThreads = [];
  if (domain) {
    emailThreads = await getGmailThreadsFromDomain(auth, domain, 20);
    console.log(`      ✓ Found ${emailThreads.length} thread(s)`);
  } else {
    console.log('      ⚠ Could not determine company domain — skipping email lookup');
  }

  // ── 4. Generate agenda with Claude ───────────────────────────────────────
  console.log('\n[4/5] Generating agenda with Claude…');
  const agenda = await generateAgenda(match, emailThreads, query);
  console.log('      ✓ Agenda generated');

  // ── 5. Print and save ─────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log(agenda);
  console.log('━'.repeat(60) + '\n');

  console.log('[5/5] Saving agenda to Google Drive…');
  const folderId = await ensureDriveFolderExists(auth, DRIVE_FOLDER_NAME);
  const docTitle = `Agenda — ${match.summary} — ${formatDateTitle(new Date())}`;
  const docUrl   = await saveGoogleDoc(auth, docTitle, agenda, folderId);
  console.log(`      ✓ Saved: ${docUrl}\n`);
}

// ─── Claude agenda generation ─────────────────────────────────────────────────

async function generateAgenda(event, emailThreads, originalQuery) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const eventDetails = formatEventDetails(event);
  const emailSection = emailThreads.length > 0
    ? emailThreads.map(t =>
        `From: ${t.from}\nDate: ${t.date}\nSubject: ${t.subject}\nSnippet: ${t.snippet}\n${t.body}`
      ).join('\n\n---\n\n')
    : 'No recent email history found for this company.';

  const prompt = `You are an executive assistant helping prepare for a meeting.

Meeting details:
${eventDetails}

Recent email history with this company/contact:
${emailSection}

Please generate a structured meeting agenda with these sections:

1. **MEETING OVERVIEW** — One paragraph summarising what this meeting is likely about based on the title, attendees, and email history.

2. **OBJECTIVES** — Bullet list of 2-4 clear goals for the meeting.

3. **TALKING POINTS** — Key topics to cover, in priority order.

4. **QUESTIONS TO ASK** — 3-5 smart, specific questions to ask the other party.

5. **RELEVANT CONTEXT FROM EMAILS** — Key insights or open threads from past email exchanges that are relevant to this meeting.

6. **PREP CHECKLIST** — Short list of anything to prepare or bring to the meeting.

Keep it actionable, concise, and professional.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Finds the calendar event whose summary best matches the user's query.
 * Uses simple case-insensitive substring matching.
 */
function findBestMatch(events, query) {
  const q = query.toLowerCase();
  // Exact or partial summary match first
  return (
    events.find(e => e.summary?.toLowerCase().includes(q)) ||
    // Fall back to matching any attendee email
    events.find(e =>
      (e.attendees || []).some(a => a.email?.toLowerCase().includes(q))
    ) ||
    null
  );
}

/**
 * Extracts the most likely company domain from external attendees.
 * Skips gmail.com and the user's own domain where possible.
 */
function extractDomainFromEvent(event) {
  const attendees = event.attendees || [];
  for (const a of attendees) {
    if (!a.email) continue;
    const domain = a.email.split('@')[1];
    if (domain && domain !== 'gmail.com') return domain;
  }
  return null;
}

function formatEventDetails(event) {
  const time      = formatEventTime(event);
  const attendees = (event.attendees || []).map(a => a.email).join(', ');
  const desc      = event.description ? `\nDescription: ${event.description.slice(0, 500)}` : '';
  return `Title: ${event.summary}\nTime: ${time}${attendees ? `\nAttendees: ${attendees}` : ''}${desc}`;
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

function formatDateTitle(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message || err);
  process.exit(1);
});
