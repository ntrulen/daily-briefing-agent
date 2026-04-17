#!/usr/bin/env node
/**
 * daily-briefing.js — CAPABILITY 1: Morning Briefing
 *
 * Scheduled to run every morning at 7:00 AM via cron (see setup-cron.sh).
 *
 * What it does:
 *   1. Fetches today's and tomorrow's Google Calendar events
 *   2. Fetches Gmail threads from a curated list of company domains
 *   3. Sends all data to Claude which writes a structured briefing
 *   4. Prints the briefing to the terminal
 *   5. Saves the briefing as a Google Doc in a "Daily Briefings" folder
 *
 * Usage:
 *   node daily-briefing.js
 */

'use strict';

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { getAuthClient } = require('./auth');
const {
  getCalendarEvents,
  getGmailThreadsFromDomains,
  ensureDriveFolderExists,
  saveGoogleDoc,
} = require('./google-helpers');

// ─── Config ──────────────────────────────────────────────────────────────────

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Companies whose emails should be surfaced in the briefing
const TRACKED_DOMAINS = [
  'instacart.com', 'target.com', 'generalmills.com', 'airbnb.com',
  'nash.ai', 'glean.com', 'amazon.com', 'gofundme.com', 'headway.com',
  'bestbuy.com', 'veeam.com', 'ramp.com', 'block.xyz', 'zillow.com',
  'shopify.com', 'stripe.com', 'asapp.com', '6sense.com',
  'outreach.io', 'teikametrics.com',
];

const DRIVE_FOLDER_NAME = 'Daily Briefings';

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(60));
  console.log('  Daily Briefing Agent — starting up…');
  console.log('━'.repeat(60));

  // ── 1. Authenticate with Google ───────────────────────────────────────────
  console.log('\n[1/5] Authenticating with Google…');
  const auth = await getAuthClient();
  console.log('      ✓ Authenticated');

  // ── 2. Fetch Calendar events ──────────────────────────────────────────────
  console.log('\n[2/5] Fetching calendar events…');

  // Today: midnight → 23:59:59
  const todayStart = startOfDay(new Date());
  const todayEnd   = endOfDay(new Date());

  // Tomorrow: midnight → 23:59:59
  const tomorrow      = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = startOfDay(tomorrow);
  const tomorrowEnd   = endOfDay(tomorrow);

  const [todayEvents, tomorrowEvents] = await Promise.all([
    getCalendarEvents(auth, CALENDAR_ID, todayStart, todayEnd),
    getCalendarEvents(auth, CALENDAR_ID, tomorrowStart, tomorrowEnd),
  ]);

  console.log(`      ✓ Today: ${todayEvents.length} event(s), Tomorrow: ${tomorrowEvents.length} event(s)`);

  // ── 3. Fetch Gmail threads ────────────────────────────────────────────────
  console.log('\n[3/5] Fetching Gmail threads from tracked companies…');
  const emailThreads = await getGmailThreadsFromDomains(auth, TRACKED_DOMAINS, 7);
  console.log(`      ✓ Found ${emailThreads.length} thread(s) from tracked domains`);

  // ── 4. Generate briefing with Claude ─────────────────────────────────────
  console.log('\n[4/5] Generating briefing with Claude…');
  const briefing = await generateBriefing(todayEvents, tomorrowEvents, emailThreads);
  console.log('      ✓ Briefing generated');

  // ── 5. Print the briefing ─────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log(briefing);
  console.log('━'.repeat(60) + '\n');

  // ── 6. Save to Google Drive ───────────────────────────────────────────────
  console.log('[5/5] Saving briefing to Google Drive…');
  const folderId = await ensureDriveFolderExists(auth, DRIVE_FOLDER_NAME);
  const docTitle = `Daily Briefing — ${formatDateTitle(new Date())}`;
  const docUrl   = await saveGoogleDoc(auth, docTitle, briefing, folderId);
  console.log(`      ✓ Saved: ${docUrl}\n`);
}

// ─── Claude briefing generation ──────────────────────────────────────────────

/**
 * Sends calendar and email data to Claude and returns the generated briefing.
 */
async function generateBriefing(todayEvents, tomorrowEvents, emailThreads) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const calendarSection = formatCalendarForPrompt(todayEvents, tomorrowEvents);
  const emailSection    = formatEmailsForPrompt(emailThreads);

  const prompt = `You are a professional executive assistant writing a morning briefing.

Here is today's calendar data:
${calendarSection}

Here are recent emails from tracked companies (last 7 days):
${emailSection}

Please write a clean, well-structured morning briefing with these sections:

1. **TODAY'S SCHEDULE** — List each meeting with time, title, and 1-2 sentences of relevant context or preparation tips where useful.

2. **TOMORROW'S PREVIEW** — Brief summary of what's coming up tomorrow.

3. **EMAIL FLAGS** — Highlight any emails from tracked companies that need attention, with a one-line summary of what action (if any) is needed.

4. **PRIORITY ACTION** — Identify the single most important thing to accomplish today.

Keep the tone professional but readable. Use markdown formatting. Be concise — the reader is busy.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

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
      const time = end ? `${start}–${end}` : start;
      const attendees = (e.attendees || []).map(a => a.email).join(', ');
      return `  - ${time}: ${e.summary || 'Untitled'}`
        + (e.description ? `\n    Description: ${e.description.slice(0, 200)}` : '')
        + (attendees ? `\n    Attendees: ${attendees}` : '');
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

// ─── Date utilities ───────────────────────────────────────────────────────────

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

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message || err);
  process.exit(1);
});
