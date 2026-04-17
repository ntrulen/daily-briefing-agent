#!/usr/bin/env node
/**
 * process-notes.js — CAPABILITY 3: Meeting Follow-Up
 *
 * Usage:
 *   node process-notes.js "https://docs.google.com/document/d/..."
 *
 * What it does:
 *   1. Reads the Google Doc at the given URL (your raw meeting notes)
 *   2. Claude extracts structured output:
 *        - Action items (with owners and suggested due dates)
 *        - Key decisions made
 *        - Open questions / parking lot items
 *        - Draft follow-up email
 *   3. Prints the output to the terminal
 *   4. Saves a follow-up Google Doc in "Daily Briefings" on Drive
 */

'use strict';

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { getAuthClient } = require('./auth');
const {
  readGoogleDoc,
  ensureDriveFolderExists,
  saveGoogleDoc,
} = require('./google-helpers');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRIVE_FOLDER_NAME = 'Daily Briefings';

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const docUrl = process.argv[2];
  if (!docUrl || !docUrl.startsWith('https://')) {
    console.error('Usage: node process-notes.js "https://docs.google.com/document/d/..."');
    process.exit(1);
  }

  console.log('━'.repeat(60));
  console.log('  Meeting Follow-Up Processor');
  console.log('━'.repeat(60));

  // ── 1. Authenticate ───────────────────────────────────────────────────────
  console.log('\n[1/4] Authenticating with Google…');
  const auth = await getAuthClient();
  console.log('      ✓ Authenticated');

  // ── 2. Read the Google Doc ────────────────────────────────────────────────
  console.log('\n[2/4] Reading Google Doc…');
  const { title, content } = await readGoogleDoc(auth, docUrl);
  console.log(`      ✓ Read "${title}" (${content.length} characters)`);

  if (!content.trim()) {
    console.error('\n✗ The document appears to be empty. Please add your meeting notes and try again.');
    process.exit(1);
  }

  // ── 3. Process with Claude ────────────────────────────────────────────────
  console.log('\n[3/4] Processing notes with Claude…');
  const followUp = await processMeetingNotes(title, content);
  console.log('      ✓ Follow-up generated');

  // ── 4. Print and save ─────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log(followUp);
  console.log('━'.repeat(60) + '\n');

  console.log('[4/4] Saving follow-up to Google Drive…');
  const folderId = await ensureDriveFolderExists(auth, DRIVE_FOLDER_NAME);
  const docTitle = `Follow-Up — ${title} — ${formatDateTitle(new Date())}`;
  const docUrl2  = await saveGoogleDoc(auth, docTitle, followUp, folderId);
  console.log(`      ✓ Saved: ${docUrl2}\n`);
}

// ─── Claude processing ────────────────────────────────────────────────────────

/**
 * Sends raw meeting notes to Claude and returns structured follow-up content.
 */
async function processMeetingNotes(docTitle, rawNotes) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `You are a professional executive assistant processing raw meeting notes.

Document title: "${docTitle}"

Raw meeting notes:
---
${rawNotes}
---

Please extract and structure the following from these notes:

1. **ACTION ITEMS**
   For each action item, provide:
   - Task description
   - Owner (person responsible) — infer from context if not explicit
   - Suggested due date (use relative terms like "by end of week", "within 2 weeks", or a specific date if mentioned)

2. **KEY DECISIONS MADE**
   Bullet list of concrete decisions that were reached during the meeting.

3. **OPEN QUESTIONS / PARKING LOT**
   Items that were raised but not resolved, need follow-up research, or were deferred.

4. **DRAFT FOLLOW-UP EMAIL**
   Write a professional follow-up email that:
   - Thanks attendees briefly
   - Recaps the key decisions
   - Lists the action items with owners
   - Has a clear subject line

Format the output cleanly with headers and bullet points. Be specific and actionable.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatDateTitle(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message || err);
  process.exit(1);
});
