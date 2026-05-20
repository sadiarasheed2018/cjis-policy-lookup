const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const PDF_PATH = path.join(__dirname, 'cjis-policy.pdf');
const OUTPUT_PATH = path.join(__dirname, 'controls.json');

// CJIS v6.0 uses NIST SP 800-53 IDs: AC-1, AC-2, AC-2(1), etc.
// Base control header: "AC-2 ACCOUNT MANAGEMENT" (all caps on its own line)
const BASE_HDR = /^([A-Z]{2,3}-\d+)\s+([A-Z][A-Z ]+[A-Z])\s*$/;
// Enhancement header: "(1) ACCOUNT MANAGEMENT | AUTOMATED SYSTEM ACCOUNT MANAGEMENT"
const ENH_HDR = /^\((\d+)\)\s+([A-Z][A-Z |]+[A-Z])\s*$/;
// All-caps line (possible title continuation for wrapped headers)
const ALL_CAPS_LINE = /^[A-Z][A-Z ]+[A-Z]\s*$/;

function isPageArtifact(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\d+$/.test(t)) return true;               // standalone page number
  if (/^12\/\d+\/2024\s*$/.test(t)) return true;  // date header
  if (/^CJISSECPOL\s*v\d/.test(t)) return true;   // version string
  if (/^\[(?:Existing|Priority)/.test(t)) return true; // [Priority N] or [Existing] [Priority N]
  return false;
}

// Footnote markers like "22F22F22F" — PDF superscript footnote numbers rendered as text.
function isFootnoteMarker(line) {
  return /^\d+F(\d+F)+\s*$/.test(line.trim());
}

// Table rows: lines that are all Title Case (every word capitalised), no ending punctuation,
// no lowercase words mid-line. These are flat-rendered PDF table cells, not prose.
// Correctly preserved: list items (a., 1.), sentences (contain lowercase mid-word), labels ending in :
function isTableRow(line) {
  const t = line.trim();
  if (!t || t.length > 80) return false;
  if (/^[a-z][\.\)]\s/.test(t)) return false;   // lettered list item: "a. Assign..."
  if (/^\d+[\.\)]\s/.test(t)) return false;      // numbered list item: "1. Authorized..."
  if (/[;:,.]$/.test(t)) return false;            // ends in sentence punctuation
  if (/\s[a-z]/.test(t)) return false;            // lowercase word mid-line → it's a sentence
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.every(w => /^[A-Z\d]/.test(w));
}

function toTitleCase(s) {
  const smallWords = new Set(['of', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'a', 'an', 'the', 'with']);
  return s.toLowerCase().split(' ').map((w, i) =>
    (i === 0 || !smallWords.has(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w
  ).join(' ');
}

async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error('cjis-policy.pdf not found. Run "npm run download" first.');
    process.exit(1);
  }

  console.log('Reading PDF...');
  const buf = fs.readFileSync(PDF_PATH);
  const { text, numpages } = await pdfParse(buf);
  console.log(`Parsed ${numpages} pages.`);

  // The TOC lists controls in Title Case (e.g. "AC-1 Policy and Procedures ....16").
  // The body lists them in ALL CAPS (e.g. "AC-1 POLICY AND PROCEDURES").
  // Skip past the TOC by anchoring to the first ALL-CAPS body header.
  const bodyStart = text.indexOf('AC-1 POLICY AND PROCEDURES', 95000);
  if (bodyStart < 0) {
    console.error('Could not find the start of the NIST control body in the PDF.');
    process.exit(1);
  }

  const lines = text.slice(bodyStart).split('\n');
  const controls = {};
  let currentId = null;
  let currentTitle = '';
  let currentBodyLines = [];
  let currentBaseId = null;  // tracks the base control (e.g. "AC-2") to build enhancement IDs
  let inHeaderZone = false;  // true while collecting a (possibly multi-line) header

  function saveCurrentControl() {
    if (!currentId) return;
    const body = currentBodyLines
      .filter(l => !isPageArtifact(l))
      .filter(l => !isFootnoteMarker(l))
      .filter(l => !isTableRow(l))
      .map(l => l.replace(/  +/g, ' '))   // collapse PDF justified-text double-spaces
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body.length >= 10) {
      controls[currentId] = { id: currentId, title: currentTitle, text: body };
    }
  }

  for (const raw of lines) {
    const trimmed = raw.trim();
    const baseMatch = trimmed.match(BASE_HDR);
    const enhMatch = trimmed.match(ENH_HDR);

    if (baseMatch) {
      saveCurrentControl();
      currentId = baseMatch[1];
      currentBaseId = currentId;
      currentTitle = toTitleCase(baseMatch[2]);
      currentBodyLines = [];
      inHeaderZone = true;
    } else if (enhMatch && currentBaseId) {
      saveCurrentControl();
      currentId = `${currentBaseId}(${enhMatch[1]})`;
      currentTitle = toTitleCase(enhMatch[2]);
      currentBodyLines = [];
      inHeaderZone = true;
    } else if (inHeaderZone && ALL_CAPS_LINE.test(trimmed) && !trimmed.startsWith('[')) {
      // Long enhancement titles sometimes wrap onto the next line (still ALL CAPS)
      currentTitle += ' ' + toTitleCase(trimmed);
    } else {
      inHeaderZone = false;
      if (currentId) currentBodyLines.push(raw);
    }
  }
  saveCurrentControl();

  const count = Object.keys(controls).length;
  if (count === 0) {
    console.error('No controls extracted. The PDF layout may have changed — check parse.js.');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(controls, null, 2));
  console.log(`Extracted ${count} controls → controls.json`);

  const ids = Object.keys(controls);
  const sampleId = ids[Math.floor(ids.length / 2)];
  const sample = controls[sampleId];
  console.log(`\nSample [${sampleId}]: ${sample.title}`);
  console.log('Preview:', sample.text.slice(0, 200).replace(/\n/g, ' ') + '...');
}

main().catch(err => {
  console.error('Parse failed:', err.message);
  process.exit(1);
});
