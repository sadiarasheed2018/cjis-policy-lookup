const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// Path to controls.json — sits one level up from this file
const CONTROLS_PATH = path.join(__dirname, '..', 'controls.json');

// Load controls once when the function starts (cached across invocations)
let controls = {};
let controlCatalog = '';

try {
  controls = JSON.parse(fs.readFileSync(CONTROLS_PATH, 'utf8'));
  controlCatalog = Object.values(controls)
    .map(c => `${c.id}: ${c.title}`)
    .join('\n');
} catch (err) {
  console.error('Failed to load controls.json:', err.message);
}

const SYSTEM_PROMPT =
  'You are a CJIS compliance assistant. Answer questions about CJIS Security Policy ' +
  'using ONLY the policy text provided to you. If the answer is not in the provided ' +
  "text, say 'That information is not in the provided policy excerpt.' Always cite the " +
  'specific control ID when giving an answer.';

const SELECTOR_PROMPT =
  'You are a CJIS expert helping select which controls are relevant to a user question. ' +
  'Return ONLY a JSON array of control IDs (e.g., ["IA-2", "IA-5", "AC-7"]). ' +
  'Select between 3 and 8 controls that are MOST relevant to the question. ' +
  'Do not include any explanation or other text.';

// Step 1: Ask Haiku to pick the most relevant control IDs
async function selectRelevantControls(anthropic, question) {
  const userMessage =
    `Here is the full list of CJIS Security Policy controls:\n\n${controlCatalog}\n\n` +
    `Question: ${question}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    system: [{ type: 'text', text: SELECTOR_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: userMessage, cache_control: { type: 'ephemeral' } }]
    }]
  });

  const raw = response.content.find(b => b.type === 'text')?.text ?? '';
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) return null;

  try {
    const ids = JSON.parse(match[0]);
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const valid = ids.map(id => String(id).trim().toUpperCase()).filter(id => controls[id]);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

module.exports = async function (context, req) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    context.res = { status: 405, body: { error: 'Method not allowed. Use POST.' } };
    return;
  }

  // Validate the question
  const question = req.body && req.body.question;
  if (!question || typeof question !== 'string' || !question.trim()) {
    context.res = { status: 400, body: { error: 'question is required in the request body' } };
    return;
  }

  // Check controls loaded
  if (Object.keys(controls).length === 0) {
    context.res = { status: 503, body: { error: 'Controls not loaded' } };
    return;
  }

  // Check API key is configured
  if (!process.env.ANTHROPIC_API_KEY) {
    context.res = { status: 500, body: { error: 'ANTHROPIC_API_KEY not configured' } };
    return;
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const q = question.trim();

    // Step 1: Haiku picks the relevant controls
    const selectedIds = await selectRelevantControls(anthropic, q);
    const relevant = selectedIds
      ? selectedIds.map(id => controls[id])
      : Object.values(controls).slice(0, 8); // fallback: just take first 8

    context.log(`Haiku selected: ${relevant.map(c => c.id).join(', ')}`);

    // Step 2: Sonnet answers using the selected controls
    const contextBlock = relevant
      .map(c => `[${c.id}] ${c.title}\n${c.text}`)
      .join('\n\n---\n\n');

    const userMessage =
      `The following CJIS Security Policy controls are relevant to this question:\n\n` +
      `${contextBlock}\n\n` +
      `Question: ${q}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }]
    });

    const answer = response.content.find(b => b.type === 'text')?.text ?? '';
    const controlsUsed = relevant.map(c => c.id);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { answer, controlsUsed }
    };

  } catch (err) {
    context.log.error('Function error:', err.message);
    context.res = {
      status: 500,
      body: { error: 'Function failed: ' + err.message }
    };
  }
};