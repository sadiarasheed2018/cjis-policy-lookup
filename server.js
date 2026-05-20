require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = 3000;
const CONTROLS_PATH = path.join(__dirname, 'controls.json');

const anthropic = new Anthropic();  // reads ANTHROPIC_API_KEY from .env

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

let controls = {};
let controlCatalog = '';  // "AC-1: Policy and Procedures\nAC-2: Account Management\n..."

function loadControls() {
  if (!fs.existsSync(CONTROLS_PATH)) {
    console.warn('controls.json not found. Run "npm run parse" to generate it.');
    return;
  }
  try {
    controls = JSON.parse(fs.readFileSync(CONTROLS_PATH, 'utf8'));
    console.log(`Loaded ${Object.keys(controls).length} controls from controls.json`);
    controlCatalog = Object.values(controls)
      .map(c => `${c.id}: ${c.title}`)
      .join('\n');
  } catch (err) {
    console.error('Failed to parse controls.json:', err.message);
  }
}

// Find the most relevant controls for a question using keyword matching.
// Returns up to maxResults full control objects, scored by keyword hit count.
function findRelevantControls(question, maxResults = 15) {
  const stopWords = new Set([
    'a','an','the','is','in','on','of','to','for','and','or','are','that',
    'this','with','what','does','how','when','which','should','must','do',
    'can','be','it','if','by','as','at','has','have','was','were','not',
    'from','about','any','all','per','my','their','its','i','me','us'
  ]);

  const keywords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return Object.values(controls).slice(0, maxResults);

  const scored = Object.values(controls).map(c => {
    const haystack = `${c.id} ${c.title} ${c.text}`.toLowerCase();
    const score = keywords.reduce((n, kw) => {
      // weight title matches higher than body matches
      const titleHits = (c.title.toLowerCase().match(new RegExp(kw, 'g')) || []).length * 3;
      const bodyHits  = (haystack.match(new RegExp(kw, 'g')) || []).length;
      return n + titleHits + bodyHits;
    }, 0);
    return { control: c, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.control);
}

// Use Haiku to pick the 3-8 most relevant control IDs for a question.
// Returns an array of ID strings, or null if the response can't be parsed.
async function selectRelevantControls(question) {
  const userMessage =
    `Here is the full list of CJIS Security Policy controls:\n\n${controlCatalog}\n\n` +
    `Question: ${question}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    system: [
      {
        type: 'text',
        text: SELECTOR_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: userMessage,
            cache_control: { type: 'ephemeral' }  // catalog is stable; cache it
          }
        ]
      }
    ]
  });

  const u = response.usage;
  console.log(
    `[Step 1] Haiku tokens — input: ${u.input_tokens}, output: ${u.output_tokens}, ` +
    `cache_read: ${u.cache_read_input_tokens ?? 0}, cache_write: ${u.cache_creation_input_tokens ?? 0}`
  );

  const raw = response.content.find(b => b.type === 'text')?.text ?? '';

  // Extract JSON array from the response (handles accidental wrapping or extra whitespace)
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) return null;

  try {
    const ids = JSON.parse(match[0]);
    if (!Array.isArray(ids) || ids.length === 0) return null;
    // Normalise to uppercase and filter to IDs that actually exist
    const valid = ids.map(id => String(id).trim().toUpperCase()).filter(id => controls[id]);
    console.log(`[Step 1] Haiku selected: ${valid.join(', ')} (${valid.length} controls)`);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

loadControls();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Look up a single control by exact ID, e.g. GET /api/control/AC-2
app.get('/api/control/:id', (req, res) => {
  const id = req.params.id;
  const control = controls[id];
  if (control) {
    res.json(control);
  } else {
    res.status(404).json({ error: `Control "${id}" not found` });
  }
});

// Full-text search, e.g. GET /api/search?q=encryption
app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  if (!query) return res.json([]);

  const results = Object.values(controls)
    .filter(c =>
      c.id.includes(query) ||
      c.title.toLowerCase().includes(query) ||
      c.text.toLowerCase().includes(query)
    )
    .slice(0, 25)
    .map(c => ({ id: c.id, title: c.title, preview: c.text.slice(0, 150) }));

  res.json(results);
});

// Return the full list of control IDs and titles
app.get('/api/controls', (req, res) => {
  const list = Object.values(controls).map(c => ({ id: c.id, title: c.title }));
  res.json(list);
});

// Ask Claude a question about CJIS policy — POST /api/ask { "question": "..." }
app.post('/api/ask', async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }

  if (Object.keys(controls).length === 0) {
    return res.status(503).json({ error: 'Controls not loaded. Run "npm run parse" first.' });
  }

  const q = question.trim();

  try {
    // ── Step 1: Haiku selects the most relevant control IDs ──────────────────
    let selectedIds = null;
    try {
      selectedIds = await selectRelevantControls(q);
    } catch (selErr) {
      console.warn('[Step 1] Haiku selection failed:', selErr.message);
    }

    let relevant;
    if (selectedIds) {
      relevant = selectedIds.map(id => controls[id]);
    } else {
      console.warn('[Step 1] Falling back to keyword search');
      relevant = findRelevantControls(q, 8);
    }

    // ── Step 2: Sonnet answers using the selected controls ───────────────────
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
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: userMessage }]
    });

    const u = response.usage;
    console.log(
      `[Step 2] Sonnet tokens — input: ${u.input_tokens}, output: ${u.output_tokens}, ` +
      `cache_read: ${u.cache_read_input_tokens ?? 0}, cache_write: ${u.cache_creation_input_tokens ?? 0}`
    );

    const answer = response.content.find(b => b.type === 'text')?.text ?? '';
    const controlsUsed = relevant.map(c => c.id);

    res.json({ answer, controlsUsed });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: 'Invalid API key — paste your key into the .env file.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limit reached — please wait a moment and try again.' });
    }
    console.error('Anthropic API error:', err.message);
    res.status(500).json({ error: 'Claude API call failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nCJIS lookup tool running at http://localhost:${PORT}\n`);
});
