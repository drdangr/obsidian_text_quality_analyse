/*
 * Text Quality Analyzer Plugin for Obsidian
 *
 * This plugin highlights paragraphs in the editor using a color gradient based on
 * signal‑to‑noise ratio (background) and complexity (text color). It also
 * provides a card‑style view listing each paragraph with its computed metrics.
 *
 * The analysis can be performed locally using simple heuristics or delegated to
 * a remote HTTP service. Configure the behaviour from the plugin’s settings.
 */

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  MarkdownView,
  Notice
} = require('obsidian');

// CodeMirror imports. These are provided by Obsidian's internal bundles.
const { ViewPlugin, Decoration } = require('@codemirror/view');
const { RangeSetBuilder, Annotation } = require('@codemirror/state');
const RefreshAnnotation = Annotation.define();

// Default settings for the plugin. Users can override these in the settings tab.
const DEFAULT_SETTINGS = {
  /**
   * Determines how paragraph metrics are computed. Possible values are:
   *  - 'auto': first try the HTTP endpoint, then fall back to the OpenAI API if a key is provided, otherwise heuristics.
   *  - 'server': use the HTTP endpoint exclusively. If unreachable, heuristics are used.
   *  - 'openai': use the OpenAI API directly. If the API key is missing or the call fails, heuristics are used.
   *  - 'heuristic': always use simple local heuristics (no external calls).
   */
  backendMode: 'auto',
  /** URL of the HTTP endpoint used when backendMode is 'server' or when 'auto' and the endpoint is reachable. */
  httpEndpoint: 'http://localhost:5000/analyze',
  /** Optional topic to bias the analysis towards. */
  topic: '',
  /** API key used when invoking embedding and chat models directly. */
  apiKey: '',
  /** Name of the embedding model to use (default: text-embedding-3-small). */
  embeddingModel: 'text-embedding-3-small',
  /** Name of the chat model used for semantic role classification. */
  chatModel: 'gpt-3.5-turbo',
  /** Whether to request semantic role classification from LLM. */
  classifyRoles: false,
  /** Method for SNR computation in OpenAI mode: 'embedding' | 'llm' */
  snrMethod: 'embedding',
  /** Color used for the maximum signal‑to‑noise intensity (1.0). */
  snrMaxColor: '#d1f9d1',
  /** Color used for the lowest complexity (simple text). Represented as a CSS hex string. */
  complexityMinColor: '#cccccc',
  /** Color used for the highest complexity (complex text). Represented as a CSS hex string. */
  complexityMaxColor: '#4c4c4c',
  /** If true, map per-note min→0 and max→1 for SNR and Complexity when colouring. */
  normalizeRanges: true
};

// Helper function to split a note into paragraphs. Blank lines separate paragraphs.
function splitIntoParagraphs(text) {
  // Collapse multiple blank lines and split on double newlines. Trim to avoid empty
  // paragraphs at the start/end of the document.
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// Compute heuristic metrics for a list of paragraphs. Each metric is normalised
// between 0 and 1. The signal‑to‑noise ratio is approximated as the fraction
// of unique tokens. Complexity is estimated by the fraction of words longer
// than six characters. Topic score counts occurrences of the topic within the
// paragraph relative to a small threshold.
function computeHeuristicMetrics(paragraphs, topic) {
  const results = [];
  const topicLower = (topic || '').toLowerCase();
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    const cleaned = words.map((w) =>
      w
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .toLowerCase()
        .trim()
    );
    const uniq = new Set(cleaned.filter((w) => w.length > 0));
    const snr = words.length > 0 ? uniq.size / words.length : 0;
    // Readability-based complexity (LIX + SMOG for Russian)
    const lix = russianLixIndex(para);
    const smogInfo = russianSmogIndex(para);
    const smog = smogInfo.value;
    const smogValid = smogInfo.valid;
    const complexity = calculateComplexity(lix, smog, smogValid);
    let topicScore = 0;
    if (topicLower.length > 0) {
      const occur = para.toLowerCase().split(topicLower).length - 1;
      topicScore = occur > 0 ? Math.min(1, occur / 3) : 0;
    }
    results.push({ snr, complexity, topic: topicScore });
  }
  return results;
}

// ===================== Readability helpers (RU) =====================
function extractRussianWords(text) {
  const match = text.match(/[А-Яа-яЁё]{2,}/gu);
  return match ? match : [];
}

function splitSentencesRussian(text) {
  if (!text) return [];
  const parts = text
    .replace(/\r\n/g, '\n')
    .split(/[.!?…]+[\s\n]*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

function countRussianSyllables(word) {
  const vowels = 'аеёиоуыэюя';
  let count = 0;
  const w = (word || '').toLowerCase();
  for (let i = 0; i < w.length; i++) {
    if (vowels.indexOf(w[i]) !== -1) count++;
  }
  return count > 0 ? count : 1;
}

function russianSmogIndex(text) {
  if (!text || !text.trim()) return { value: null, valid: false };
  const sentences = splitSentencesRussian(text);
  const numSentences = sentences.length;
  const isValid = numSentences >= 3;
  if (numSentences === 0) return { value: null, valid: false };
  const words = extractRussianWords(text);
  if (words.length === 0) return { value: null, valid: isValid };
  let polysyllableCount = 0;
  for (const w of words) {
    if (countRussianSyllables(w) >= 3) polysyllableCount++;
  }
  try {
    const smogRaw = polysyllableCount * (30 / numSentences);
    const smog = 1.043 * Math.sqrt(smogRaw) + 3.1291;
    return { value: Math.round(smog * 1000) / 1000, valid: isValid };
  } catch (e) {
    return { value: null, valid: isValid };
  }
}

function russianLixIndex(text) {
  if (!text || !text.trim()) return null;
  const sentences = splitSentencesRussian(text);
  const numSentences = sentences.length;
  if (numSentences === 0) return null;
  const words = extractRussianWords(text);
  const numWords = words.length;
  if (numWords === 0) return null;
  const numLongWords = words.reduce((acc, w) => (w.length > 6 ? acc + 1 : acc), 0);
  try {
    const lix = numWords / numSentences + 100 * (numLongWords / numWords);
    return Math.round(lix * 1000) / 1000;
  } catch (e) {
    return null;
  }
}

function normalizeScore(value, min, max) {
  if (value === null || value === undefined || !isFinite(value)) return NaN;
  const clipped = Math.min(Math.max(value, min), max);
  if (max === min) return 0;
  return Math.round(((clipped - min) / (max - min)) * 1000) / 1000;
}

function calculateComplexity(lix, smog, smogValid) {
  const SCALE_LIX = [0, 80];
  const SCALE_SMOG = [3, 20];
  const nLix = normalizeScore(lix, SCALE_LIX[0], SCALE_LIX[1]);
  const nSmog = smogValid ? normalizeScore(smog, SCALE_SMOG[0], SCALE_SMOG[1]) : NaN;
  const vals = [];
  if (!isNaN(nLix)) vals.push(nLix);
  if (!isNaN(nSmog)) vals.push(nSmog);
  if (vals.length === 0) return 0; // fallback
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg * 1000) / 1000;
}

// Convert a numeric ratio (0‑1) into a pastel hue. A low ratio maps to red and
// a high ratio maps to green. Saturation and lightness are fixed to produce
// pleasant pastel shades.
function snrToBackgroundColor(snr) {
  const hue = Math.max(0, Math.min(120, snr * 120));
  return `hsl(${hue}, 80%, 90%)`;
}

// Convert complexity into a greyscale text colour. High complexity results in a
// darker colour; low complexity yields lighter text. The range of lightness is
// capped between 30% and 80% for readability.
function complexityToTextColor(complexity) {
  const lightness = 30 + (1 - Math.max(0, Math.min(1, complexity))) * 50;
  return `hsl(0, 0%, ${lightness}%)`;
}

// Helpers to interpolate between two hex colours. These functions convert
// hex strings to RGB tuples, interpolate linearly and return a new hex
// string. They are used to build colour gradients based on plugin
// settings.
function hexToRgb(hex) {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function interpolateColor(hex1, hex2, t) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return rgbToHex({ r, g, b });
}

// Parse CSS color string (#hex or rgb/rgba) to {r,g,b}
function cssColorToRgb(color) {
  if (!color) return { r: 255, g: 255, b: 255 };
  const c = color.trim();
  if (c.startsWith('#')) return hexToRgb(c);
  const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
  }
  // Fallback to white
  return { r: 255, g: 255, b: 255 };
}

/**
 * Robust wrapper for OpenAI chat completions that adapts to models which
 * require 'max_completion_tokens' instead of 'max_tokens' (e.g. gpt‑5 family).
 * Returns parsed JSON body.
 */
async function callOpenAiChat(apiKey, model, messages, options = {}) {
  const { temperature = 0, maxTokens = undefined, responseFormat = undefined } = options;
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const baseHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const prefersCompletionTokens = /gpt-5/i.test(model || '');
  const baseBody = { model, messages };
  // gpt-5 family не поддерживает произвольную температуру — используем значение по умолчанию (не передаём параметр)
  if (!prefersCompletionTokens && typeof temperature === 'number') baseBody.temperature = temperature;
  if (responseFormat) baseBody.response_format = responseFormat;

  // Choose token field based on model family
  const body1 = Object.assign({}, baseBody);
  if (typeof maxTokens === 'number') {
    if (prefersCompletionTokens) body1.max_completion_tokens = maxTokens;
    else body1.max_tokens = maxTokens;
  }
  let res = await fetch(endpoint, { method: 'POST', headers: baseHeaders, body: JSON.stringify(body1) });
  if (res.ok) return await res.json();
  // Inspect error to decide retry
  let errText = '';
  try { errText = await res.text(); } catch (e) {}
  let shouldRetry = false;
  try {
    const errJson = JSON.parse(errText);
    const msg = errJson?.error?.message || '';
    const param = errJson?.error?.param || '';
    if (param === 'max_tokens' || param === 'max_completion_tokens' || msg.toLowerCase().includes('max_tokens') || msg.toLowerCase().includes('max_completion_tokens')) {
      shouldRetry = true;
    }
  } catch (e) {
    // If we cannot parse, still try retry path for gpt‑5 models heuristically
    if ((model || '').includes('gpt-5')) shouldRetry = true;
  }
  if (!shouldRetry) {
    console.error('TQA: chat completion error (no retry)', res.status, res.statusText, errText);
    throw new Error('Chat completion failed');
  }
  // Second attempt with max_completion_tokens
  const body2 = Object.assign({}, baseBody);
  if (typeof maxTokens === 'number') body2.max_completion_tokens = prefersCompletionTokens ? undefined : maxTokens;
  if (typeof maxTokens === 'number') body2.max_tokens = prefersCompletionTokens ? undefined : body2.max_tokens;
  // Flip fields explicitly
  if (typeof maxTokens === 'number') {
    if (prefersCompletionTokens) {
      body2.max_tokens = maxTokens; // try the other field
      delete body2.max_completion_tokens;
    } else {
      body2.max_completion_tokens = maxTokens;
      delete body2.max_tokens;
    }
  }
  new Notice('Chat model token parameter adjusted; retrying request.');
  res = await fetch(endpoint, { method: 'POST', headers: baseHeaders, body: JSON.stringify(body2) });
  if (!res.ok) {
    let err2 = '';
    try { err2 = await res.text(); } catch (e) {}
    console.error('TQA: chat completion retry failed', res.status, res.statusText, err2);
    throw new Error('Chat completion failed');
  }
  return await res.json();
}

// Responses API support for gpt-5 has been removed due to instability.

/**
 * Request vector embeddings for an array of texts via the OpenAI API. The
 * returned embeddings are arrays of floats. If the API call fails, an error
 * will be thrown. The model name must be specified (e.g. 'text-embedding-3-small').
 *
 * @param {string} apiKey  The API key used for authorization.
 * @param {string} model   The name of the embedding model.
 * @param {string[]} texts An array of strings to embed.
 * @returns {Promise<number[][]>} A promise resolving to an array of embedding vectors.
 */
async function fetchOpenAiEmbeddings(apiKey, model, texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ input: texts, model })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Embedding request failed: ${res.status} ${res.statusText} ${err}`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.data)) throw new Error('Invalid embedding response');
  return data.data.map((item) => item.embedding);
}

/**
 * Compute the cosine similarity between two numeric vectors. The result is
 * normalised to the range [0, 1] where 1 indicates identical direction and 0
 * indicates orthogonality. Negative similarities (opposite directions) map to 0.
 *
 * @param {number[]} a First vector
 * @param {number[]} b Second vector
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  let sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Map from [-1,1] to [0,1]
  if (sim < -1) sim = -1;
  if (sim > 1) sim = 1;
  return (sim + 1) / 2;
}

// Robustly parse LLM JSON content which may be double-encoded or wrapped in code fences
function parseLlmScoresAndComplexity(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return null;
  let txt = rawContent.trim();
  // Strip common code fences
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Sometimes the whole JSON object comes inside extra quotes / is doubly encoded
  let parsed = null;
  const tryParse = (s) => {
    try {
      const p = JSON.parse(s);
      if (typeof p === 'string') return JSON.parse(p);
      return p;
    } catch (e) {
      return null;
    }
  };
  parsed = tryParse(txt);
  if (!parsed) {
    // Try to extract the first JSON object
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const objText = m[0].replace(/[""]/g, '"').replace(/['']/g, "'");
      parsed = tryParse(objText);
    }
  }
  // If still no luck, try to repair truncated JSON
  if (!parsed && txt.includes('"scores"') && txt.includes('[')) {
    try {
      // Try to close unclosed arrays and objects
      let repaired = txt;
      // Count open brackets
      const openBrackets = (repaired.match(/\[/g) || []).length;
      const closeBrackets = (repaired.match(/\]/g) || []).length;
      const openBraces = (repaired.match(/\{/g) || []).length;
      const closeBraces = (repaired.match(/\}/g) || []).length;
      
      // Add missing closing brackets
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        repaired += ']';
      }
      for (let i = 0; i < openBraces - closeBraces; i++) {
        repaired += '}';
      }
      
      // Remove trailing comma if present
      repaired = repaired.replace(/,(\s*[\]\}])/g, '$1');
      
      parsed = tryParse(repaired);
      if (parsed) {
        console.info('TQA: Successfully repaired truncated JSON');
      }
    } catch (e) {
      // Repair failed, will return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const scores = Array.isArray(parsed.scores) ? parsed.scores : (Array.isArray(parsed) ? parsed : null);
  const complexity = Array.isArray(parsed.complexity) ? parsed.complexity : null;
  return { scores, complexity };
}

function clamp01(n) {
  n = Number(n);
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeArray01(arr, targetLen) {
  if (!Array.isArray(arr)) arr = [];
  let out = arr.map((x) => clamp01(x));
  if (out.length > targetLen) out = out.slice(0, targetLen);
  if (out.length < targetLen) out = out.concat(new Array(targetLen - out.length).fill(0));
  return out;
}

/**
 * Request semantic role classification for an array of paragraphs using the
 * OpenAI chat completions API. Each paragraph is classified independently.
 * The system prompt instructs the model to choose one role from a predefined
 * list and return only the label without explanation. Returns an array of
 * strings corresponding to each paragraph. If the request fails, an error
 * will be thrown.
 *
 * @param {string} apiKey      The API key used for authorization.
 * @param {string} model       The chat model to use (e.g. gpt-3.5-turbo).
 * @param {string[]} paragraphs The paragraphs to classify.
 * @returns {Promise<string[]>}
 */
async function fetchOpenAiRoles(apiKey, model, paragraphs) {
  const roles = [];
  // Define a fixed set of semantic roles. Feel free to expand this list as needed.
  const roleList = [
    'humor',
    'assertion',
    'theme development',
    'analogy explanation',
    'example',
    'contrast',
    'background information',
    'conclusion',
    'question',
    'other'
  ];
  for (const para of paragraphs) {
    const messages = [
      {
        role: 'system',
        content:
          'You are a semantic classifier. Given a paragraph of text, classify its semantic role into one of the following categories: ' +
          roleList.join(', ') +
          '. Respond with only the label that best fits the paragraph.'
      },
      { role: 'user', content: para }
    ];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 20,
        temperature: 0
      })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Role request failed: ${res.status} ${res.statusText} ${err}`);
    }
    const data = await res.json();
    const role = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    roles.push(role ? role.trim() : 'other');
  }
  return roles;
}

// View type identifier for the card view. This must be unique across all
// plugins. Change it if you build another similar plugin.
const VIEW_TYPE = 'text-quality-cards';

// The card view class. Presents paragraph metrics as individual cards. Each
// card displays a snippet of the paragraph along with its computed scores and
// offers a link to jump back into the editor.
class TQAView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.cardsContainer = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Text Quality Cards';
  }

  async onOpen() {
    this.containerEl.empty();
    const header = this.containerEl.createEl('h3', {
      text: 'Text Quality Analyzer'
    });
    this.cardsContainer = this.containerEl.createDiv({ cls: 'tqa-cards-view' });
    // If there is cached data from a prior analysis, render it.
    if (this.plugin.metricsCache) {
      this.renderMetrics(this.plugin.metricsCache);
    } else {
      this.cardsContainer.createEl('p', {
        text: 'No analysis yet. Run “Analyze Current Note” from the command palette.'
      });
    }
  }

  async onClose() {
    // Nothing to clean up.
  }

  /**
   * Render a list of paragraph metrics into the card view. The provided
   * metricsCache object should have the shape { file, metrics, paragraphs }.
   */
  renderMetrics(metricsCache) {
    const { metrics, paragraphs } = metricsCache;
    this.cardsContainer.empty();
    if (!metrics || metrics.length === 0) {
      this.cardsContainer.createEl('p', { text: 'No paragraphs found.' });
      return;
    }
    metrics.forEach((m, idx) => {
      const card = this.cardsContainer.createDiv({ cls: 'tqa-card' });
      // Snippet only (no heading)
      const snippet = paragraphs[idx].length > 200 ? paragraphs[idx].slice(0, 200) + '…' : paragraphs[idx];
      card.createEl('p', { text: snippet });
      // Metrics in one compact line
      const parts = [
        `Signal‑to‑noise: ${m.snr.toFixed(2)}`,
        `Complexity: ${m.complexity.toFixed(2)}`
      ];
      if (m.role && m.role.trim()) parts.push(`Role: ${m.role}`);
      card.createEl('p', { text: parts.join('  •  ') });
      // No "Go to paragraph" link per request
    });
  }

  /**
   * Jump to a given paragraph index in the currently active editor. This walks
   * through the document to identify the start line of the requested
   * paragraph and scrolls the editor into view.
   */
  jumpToParagraph(index) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) return;
    const editor = activeView.editor;
    const lines = editor.getValue().split(/\n/);
    let currentIdx = 0;
    let firstLineOfParagraph = 0;
    let inParagraph = false;
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln];
      if (line.trim() === '') {
        if (inParagraph) {
          if (currentIdx === index) {
            break;
          }
          currentIdx++;
          inParagraph = false;
        }
      } else {
        if (!inParagraph) {
          inParagraph = true;
          if (currentIdx === index) {
            firstLineOfParagraph = ln;
          }
        }
      }
    }
    // Position the cursor at the beginning of the paragraph and scroll into view.
    editor.setCursor({ line: firstLineOfParagraph, ch: 0 });
    editor.scrollIntoView({ from: { line: firstLineOfParagraph, ch: 0 }, to: { line: firstLineOfParagraph, ch: 0 } }, true);
  }
}

// Settings tab UI. Provides controls for selecting the backend mode, remote
// endpoint and the optional topic string.
class TQASettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Text Quality Analyzer Settings' });
    // Backend mode selector
    new Setting(containerEl)
      .setName('Analysis mode')
      .setDesc(
        'Determine how metrics are computed: auto will try the HTTP server first, then OpenAI if a key is provided, otherwise heuristics. Server forces use of the HTTP endpoint. OpenAI forces direct calls to the OpenAI API. Heuristic disables all external calls.'
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', 'Auto (server → OpenAI → heuristic)');
        dropdown.addOption('server', 'HTTP server');
        dropdown.addOption('openai', 'OpenAI API');
        dropdown.addOption('heuristic', 'Heuristics only');
        dropdown.setValue(this.plugin.settings.backendMode);
        dropdown.onChange(async (value) => {
          this.plugin.settings.backendMode = value;
          await this.plugin.saveSettings();
        });
      });
    // HTTP endpoint input
    new Setting(containerEl)
      .setName('HTTP Endpoint')
      .setDesc(
        'URL of the analysis service used when analysis mode is set to "HTTP server" or when auto mode detects an available server. Defaults to http://localhost:5000/analyze.'
      )
      .addText((text) => {
        text.setPlaceholder('http://localhost:5000/analyze');
        text.setValue(this.plugin.settings.httpEndpoint || 'http://localhost:5000/analyze');
        text.onChange(async (value) => {
          this.plugin.settings.httpEndpoint = value.trim() || 'http://localhost:5000/analyze';
          await this.plugin.saveSettings();
        });
      });
    // Topic input
    new Setting(containerEl)
      .setName('Topic')
      .setDesc('Optional topic string to measure paragraph relevance. Leave blank for none.')
      .addText((text) => {
        text.setPlaceholder('e.g. магический реализм');
        text.setValue(this.plugin.settings.topic);
        text.onChange(async (value) => {
          this.plugin.settings.topic = value;
          await this.plugin.saveSettings();
        });
      });

    // API key input
    new Setting(containerEl)
      .setName('API key')
      .setDesc('Secret key for calling embedding and chat models. This value is stored locally and should not be committed to version control.')
      .addText((text) => {
        text.setPlaceholder('sk-...');
        text.setValue(this.plugin.settings.apiKey || '');
        text.onChange(async (value) => {
          this.plugin.settings.apiKey = value.trim();
          await this.plugin.saveSettings();
        });
      });

    // Embedding model selector
    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Name of the embedding model (e.g. text-embedding-3-small).')
      .addText((text) => {
        text.setPlaceholder('text-embedding-3-small');
        text.setValue(this.plugin.settings.embeddingModel || 'text-embedding-3-small');
        text.onChange(async (value) => {
          this.plugin.settings.embeddingModel = value.trim() || 'text-embedding-3-small';
          await this.plugin.saveSettings();
          // Changing the embedding model should invalidate caches and re-run analysis
          if (typeof this.plugin.resetAnalysisCache === 'function') {
            this.plugin.resetAnalysisCache(true);
          }
        });
      });

    // Chat model selector
    new Setting(containerEl)
      .setName('Chat model')
      .setDesc('Model for semantic role classification and LLM SNR scoring.')
      .addDropdown((dropdown) => {
        const options = {
          'gpt-3.5-turbo': 'gpt-3.5-turbo',
          'gpt-4o-mini': 'gpt-4o-mini',
          'gpt-4o': 'gpt-4o'
        };
        Object.entries(options).forEach(([k, v]) => dropdown.addOption(k, v));
        dropdown.setValue(this.plugin.settings.chatModel || 'gpt-3.5-turbo');
        dropdown.onChange(async (value) => {
          this.plugin.settings.chatModel = value;
          await this.plugin.saveSettings();
          if (typeof this.plugin.resetAnalysisCache === 'function') {
            this.plugin.resetAnalysisCache(true);
          }
        });
      });

    // Toggle: classify semantic roles
    new Setting(containerEl)
      .setName('Classify semantic roles')
      .setDesc('If enabled, the plugin will call the chat model to classify the semantic role of each paragraph (OpenAI/Auto modes only).')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.classifyRoles ?? false);
        toggle.onChange(async (value) => {
          this.plugin.settings.classifyRoles = value;
          await this.plugin.saveSettings();
          if (typeof this.plugin.resetAnalysisCache === 'function') {
            this.plugin.resetAnalysisCache(true);
          }
        });
      });

    // SNR method selector (OpenAI mode only)
    new Setting(containerEl)
      .setName('SNR method (OpenAI)')
      .setDesc("Choose how to compute SNR in OpenAI mode: embeddings cosine similarity or direct LLM scoring vs topic.")
      .addDropdown((dropdown) => {
        dropdown.addOption('embedding', 'Embeddings (cosine)');
        dropdown.addOption('llm', 'LLM scoring');
        dropdown.setValue(this.plugin.settings.snrMethod || 'embedding');
        dropdown.onChange(async (value) => {
          this.plugin.settings.snrMethod = value;
          await this.plugin.saveSettings();
          if (typeof this.plugin.resetAnalysisCache === 'function') this.plugin.resetAnalysisCache(true);
        });
      });

    // Colour pickers for signal-to-noise gradient (background)
    new Setting(containerEl)
      .setName('SNR highlight colour (max)')
      .setDesc('Choose the background colour used for SNR=1. SNR=0 uses the editor default background.')
      .addColorPicker((picker) => {
        picker.setValue(this.plugin.settings.snrMaxColor || '#d1f9d1');
        picker.onChange(async (value) => {
          this.plugin.settings.snrMaxColor = value;
          await this.plugin.saveSettings();
          this.plugin.metricsVersion = (this.plugin.metricsVersion || 0) + 1;
          try {
            const cm = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.cm;
            if (cm && typeof cm.dispatch === 'function') cm.dispatch({ effects: [] });
          } catch (e) {}
        });
      });

    // Toggle: normalise ranges when colouring
    new Setting(containerEl)
      .setName('Normalise ranges for colouring')
      .setDesc('If enabled, per-note min values map to 0 and max values map to 1 for SNR and Complexity when computing colours. If disabled, raw metric values are used as-is (may exceed [0,1]).')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.normalizeRanges ?? true);
        toggle.onChange(async (value) => {
          this.plugin.settings.normalizeRanges = value;
          await this.plugin.saveSettings();
          this.plugin.metricsVersion = (this.plugin.metricsVersion || 0) + 1;
          try {
            const cm = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.cm;
            if (cm && typeof cm.dispatch === 'function') cm.dispatch({ effects: [] });
          } catch (e) {}
        });
      });

    // Colour pickers for complexity gradient (text)
    new Setting(containerEl)
      .setName('Complexity colours')
      .setDesc('Choose gradient colours for text. Left: simple, Right: complex')
      .addColorPicker((picker) => {
        picker.setValue(this.plugin.settings.complexityMinColor || '#cccccc');
        picker.onChange(async (value) => {
          this.plugin.settings.complexityMinColor = value;
          await this.plugin.saveSettings();
          this.plugin.metricsVersion = (this.plugin.metricsVersion || 0) + 1;
          try {
            const cm = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.cm;
            if (cm && typeof cm.dispatch === 'function') cm.dispatch({ effects: [] });
          } catch (e) {}
        });
      })
      .addColorPicker((picker) => {
        picker.setValue(this.plugin.settings.complexityMaxColor || '#4c4c4c');
        picker.onChange(async (value) => {
          this.plugin.settings.complexityMaxColor = value;
          await this.plugin.saveSettings();
          this.plugin.metricsVersion = (this.plugin.metricsVersion || 0) + 1;
          try {
            const cm = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.cm;
            if (cm && typeof cm.dispatch === 'function') cm.dispatch({ effects: [] });
          } catch (e) {}
        });
      });
  }
}

// Main plugin class. Handles editor decorations, file analysis and view
// management. Extends Obsidian’s Plugin base class.
module.exports = class TextQualityAnalyzerPlugin extends Plugin {
  async onload() {
    // Load persisted settings
    await this.loadSettings();
    // Attempt to load API key from a local .env file if not already set
    await this.loadApiKeyFromEnv();
    // Persist any changes from .env loading
    await this.saveSettings();
    this.metricsCache = null;
    // Version counter for metrics; increments every time metrics are recomputed.
    // Used by the editor decoration plugin to know when to refresh colours
    // even if the document text itself did not change.
    this.metricsVersion = 0;
    this._subjectEmbeddingCache = null;
    this._statusBarItem = null;
    // Debounce timeout for partial analysis after typing pauses
    this._analysisTimeout = null;
    // Track current analysis to prevent overlapping requests
    this._currentAnalysis = null;
    // Register the custom view type
    this.registerView(VIEW_TYPE, (leaf) => new TQAView(leaf, this));
    // Register the settings tab
    this.addSettingTab(new TQASettingTab(this.app, this));
    // Create and register the CodeMirror decoration extension
    this.decorationsExtension = this.createDecorationsExtension();
    this.registerEditorExtension(this.decorationsExtension);
    // Command to open the card view
    this.addCommand({
      id: 'open-text-quality-cards',
      name: 'Open Text Quality Cards',
      callback: () => this.activateView()
    });
    // Command to reanalyse the current note
    this.addCommand({
      id: 'reanalyze-text-quality',
      name: 'Analyze Current Note',
      callback: () => this.reanalyzeForced()
    });
    // Recompute metrics whenever the active file changes
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.reanalyzeForced();
    }));

    // Add a ribbon icon on the left to quickly open this plugin's settings
    this.ribbonIconEl = this.addRibbonIcon(
      'lines-of-text',
      'Text Quality Analyzer: Open Settings',
      () => {
        try {
          this.app.setting.open();
          // Navigate directly to this plugin's tab if available
          if (typeof this.app.setting.openTabById === 'function') {
            this.app.setting.openTabById(this.manifest.id);
          }
        } catch (e) {
          // ignore
        }
      }
    );

    // Create status bar item for background LLM/server analysis
    this._statusBarItem = this.addStatusBarItem();
    this._statusBarItem.addClass('tqa-status');
    this._statusBarItem.setAttr('aria-live', 'polite');
    this._statusBarItem.style.display = 'none';
    const spinner = this._statusBarItem.createDiv({ cls: 'tqa-spinner' });
    const label = this._statusBarItem.createSpan();
    label.setText('Analyzing…');
  }

  onunload() {
    // Nothing to unload explicitly since Obsidian cleans up registered events and views.
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Запускает полный анализ всего файла.
   * Этот метод вызывается вручную (по команде или при открытии файла).
   */
  async reanalyzeForced() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    // Cancel pending partial analysis debounce
    if (this._analysisTimeout) {
      clearTimeout(this._analysisTimeout);
      this._analysisTimeout = null;
    }

    // Cancel any ongoing analysis
    if (this._currentAnalysis) {
      this._currentAnalysis.cancelled = true;
    }

    // Clear cache immediately when switching files
    if (this.metricsCache && this.metricsCache.file !== file.path) {
      this.metricsCache = null;
      this._subjectEmbeddingCache = null;
    }

    const text = await this.app.vault.read(file);
    const paragraphs = splitIntoParagraphs(text);

    // Create a new analysis context
    const analysisContext = { cancelled: false, file: file.path };
    this._currentAnalysis = analysisContext;

    // Show spinner while we may be calling server/LLM
    this.showBusy(true);
    const metrics = await this.getMetrics(paragraphs).finally(() => {
      // Only hide spinner if this is still the current analysis
      if (this._currentAnalysis === analysisContext) {
        this.showBusy(false);
      }
    });

    // Check if this analysis was cancelled
    if (analysisContext.cancelled) {
      return;
    }

    // Persist ranges for stable colouring between live edits
    const snrValues = (metrics || []).map((m) => (typeof m.snr === 'number' ? m.snr : 0));
    const compValues = (metrics || []).map((m) => (typeof m.complexity === 'number' ? m.complexity : 0));
    const ranges = {
      snrMin: snrValues.length ? Math.min(...snrValues) : 0,
      snrMax: snrValues.length ? Math.max(...snrValues) : 1,
      compMin: compValues.length ? Math.min(...compValues) : 0,
      compMax: compValues.length ? Math.max(...compValues) : 1
    };
    this.metricsCache = { file: file.path, metrics, paragraphs, ranges };
    // Signal to the editor decoration plugin that metrics have changed
    this.metricsVersion = (this.metricsVersion || 0) + 1;
    // Refresh decorations immediately after computing metrics
    this._forceRefreshEditors();
    // Update card view if it is open
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof view.renderMetrics === 'function') {
        view.renderMetrics(this.metricsCache);
      }
    }
  }

  /**
   * Запускает точечный анализ для указанных абзацев с задержкой.
   * Этот метод будет вызван после паузы в наборе текста.
   */
  reanalyzeWithDebounce(indices) {
    if (this._analysisTimeout) {
      clearTimeout(this._analysisTimeout);
    }
    this._analysisTimeout = setTimeout(async () => {
      this._analysisTimeout = null;
      const file = this.app.workspace.getActiveFile();
      if (!file) return;

      const text = await this.app.vault.read(file);
      const paragraphs = splitIntoParagraphs(text);

      this.showBusy(true);
      try {
        const partial = await this.recomputeMetricsForIndices(paragraphs, indices);
        if (this.metricsCache && this.metricsCache.file === file.path) {
          indices.forEach((i) => {
            if (this.metricsCache.metrics[i]) {
              if (Object.prototype.hasOwnProperty.call(partial.snrByIndex, i)) {
                const v = partial.snrByIndex[i];
                this.metricsCache.metrics[i].snr = typeof v === 'number' ? v : 0;
                this.metricsCache.metrics[i].topic = typeof v === 'number' ? v : 0;
              }
              if (Object.prototype.hasOwnProperty.call(partial.complexityByIndex, i)) {
                const c = partial.complexityByIndex[i];
                if (typeof c === 'number') this.metricsCache.metrics[i].complexity = c;
              }
            }
          });

          this.metricsVersion = (this.metricsVersion || 0) + 1;
          this._forceRefreshEditors();

          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          for (const leaf of leaves) {
            const view = leaf.view;
            if (view && typeof view.renderMetrics === 'function') {
              view.renderMetrics(this.metricsCache);
            }
          }
        }
      } catch (err) {
        new Notice('Ошибка при анализе абзацев.');
        console.error('Ошибка при reanalyzeWithDebounce:', err);
      } finally {
        this.showBusy(false);
      }
    }, 1000);
  }

  /**
   * Create a CodeMirror ViewPlugin that decorates entire lines according to
   * paragraph metrics. Whenever the document changes, paragraphs are
   * re‑extracted and the associated colours recomputed. Rendering is debounced
   * implicitly by CodeMirror’s update cycle.
   */
  createDecorationsExtension() {
    const plugin = this;
    return ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.view = view;
          this.decorations = Decoration.none;
          this.computeDecorations();
        }

        /**
         * Trigger an asynchronous recompute of the decoration set. The
         * computation happens serially; subsequent requests will reuse the
         * latest metrics. On completion, the decorations are replaced and the
         * view updated.
         */
        async computeDecorations() {
          const file = plugin.app.workspace.getActiveFile();
          const state = this.view.state;
          const docText = state.doc.toString();
          // Skip processing if no file is open (e.g. the welcome screen)
          if (!file) {
            this.decorations = Decoration.none;
            return;
          }
          // If metrics are not computed yet, request them and exit; the plugin
          // will bump metricsVersion and we will recompute on the next update.
          if (!plugin.metricsCache || plugin.metricsCache.file !== file.path) {
            // Fire and forget; no await to avoid recursion in updates
            plugin.reanalyzeForced();
          }
          const paragraphs = splitIntoParagraphs(docText);
          // Acquire metrics: use cached metrics if the same number of paragraphs
          let metrics;
          if (
            plugin.metricsCache &&
            plugin.metricsCache.file === file.path &&
            plugin.metricsCache.paragraphs &&
            plugin.metricsCache.paragraphs.length === paragraphs.length
          ) {
            metrics = plugin.metricsCache.metrics;
          } else {
            metrics = await plugin.getMetrics(paragraphs);
            // store for reuse in view and card view
            plugin.metricsCache = {
              file: file.path,
              metrics,
              paragraphs
            };
          }
          const builder = new RangeSetBuilder();
          const totalLines = state.doc.lines;
          let paraIdx = 0;
          let currentLines = [];

          // Ranges for normalisation
          let snrMin = 0, snrMax = 1, compMin = 0, compMax = 1;
          if (plugin.settings.normalizeRanges && plugin.metricsCache && plugin.metricsCache.ranges) {
            const r = plugin.metricsCache.ranges;
            snrMin = r.snrMin; snrMax = r.snrMax; compMin = r.compMin; compMax = r.compMax;
          }
          const normalize = (value, min, max) => {
            if (!plugin.settings.normalizeRanges) {
              // clamp raw value to [0,1] for colouring only
              return Math.max(0, Math.min(1, value || 0));
            }
            const range = max - min;
            if (!isFinite(range) || range <= 1e-9) return 0.5; // all equal → mid colour
            const t = (value - min) / range;
            return Math.max(0, Math.min(1, t));
          };
          for (let lineNumber = 1; lineNumber <= totalLines; lineNumber++) {
            const line = state.doc.line(lineNumber).text;
            if (line.trim() === '') {
              if (currentLines.length > 0) {
                if (metrics[paraIdx]) {
                  const { snr, complexity } = metrics[paraIdx];
                  // Normalise colours per current analysis
                  const normSnr = normalize(snr, snrMin, snrMax);
                  const normComplexity = normalize(complexity, compMin, compMax);
                  const bg = plugin.getBackgroundColorFor(normSnr);
                  const fg = plugin.getTextColorFor(normComplexity);
                  currentLines.forEach((ln) => {
                    const range = state.doc.line(ln);
                    const deco = Decoration.line({
                      attributes: {
                        style: `background-color: ${bg}; color: ${fg};`
                      }
                    });
                    builder.add(range.from, range.from, deco);
                  });
                }
                paraIdx++;
                currentLines = [];
              }
            } else {
              currentLines.push(lineNumber);
            }
          }
          // handle trailing paragraph
          if (currentLines.length > 0 && metrics[paraIdx]) {
            const { snr, complexity } = metrics[paraIdx];
            const normSnr = normalize(snr, snrMin, snrMax);
            const normComplexity = normalize(complexity, compMin, compMax);
            const bg = plugin.getBackgroundColorFor(normSnr);
            const fg = plugin.getTextColorFor(normComplexity);
            currentLines.forEach((ln) => {
              const range = state.doc.line(ln);
              const deco = Decoration.line({
                attributes: {
                  style: `background-color: ${bg}; color: ${fg};`
                }
              });
              builder.add(range.from, range.from, deco);
            });
          }
          this.decorations = builder.finish();
        }

        update(update) {
          // When document changes, update complexity on-the-fly for changed paragraphs only
          if (update.docChanged) {
            const file = plugin.app.workspace.getActiveFile();
            if (!file) return;

            const state = this.view.state;
            // Build paragraph ranges in the NEW doc
            const paraRanges = [];
            let currentParaStart = 0;
            for (let i = 1; i <= state.doc.lines; i++) {
              const line = state.doc.line(i);
              if (line.text.trim() === '') {
                if (line.from > currentParaStart) {
                  paraRanges.push({ from: currentParaStart, to: line.from });
                }
                currentParaStart = line.to + 1;
              }
            }
            if (state.doc.length > currentParaStart) {
              paraRanges.push({ from: currentParaStart, to: state.doc.length });
            }

            // Collect changed ranges in NEW doc coordinates
            const changedRanges = [];
            try {
              update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                changedRanges.push({ from: fromB, to: toB });
              });
            } catch (e) {
              // Fallback: mark all as changed
              changedRanges.push({ from: 0, to: state.doc.length });
            }

            // Prepare new metrics and paragraph texts, preserving previous where unchanged
            const prev = plugin.metricsCache && plugin.metricsCache.file === file.path ? plugin.metricsCache : null;
            const newMetrics = new Array(paraRanges.length);
            const newParaTexts = new Array(paraRanges.length);
            const changedIndices = new Set();

            paraRanges.forEach((para, i) => {
              const paraText = state.doc.sliceString(para.from, para.to).trim();
              newParaTexts[i] = paraText;

              // Determine if this paragraph intersects any changed range
              let isChanged = false;
              for (const r of changedRanges) {
                if (r.from < para.to && r.to > para.from) { isChanged = true; break; }
              }
              if (isChanged) changedIndices.add(i);

              if (!isChanged && prev && prev.metrics && prev.metrics[i]) {
                newMetrics[i] = prev.metrics[i];
              } else {
                const smogInfo = russianSmogIndex(paraText);
                const lix = russianLixIndex(paraText);
                const complexity = calculateComplexity(lix, smogInfo.value, smogInfo.valid);
                newMetrics[i] = { snr: 0, complexity, topic: 0, role: '' };
              }
            });

            const ranges = prev && prev.ranges ? prev.ranges : null;
            plugin.metricsCache = ranges
              ? { file: file.path, metrics: newMetrics, paragraphs: newParaTexts, ranges }
              : { file: file.path, metrics: newMetrics, paragraphs: newParaTexts };
            plugin.metricsVersion = (plugin.metricsVersion || 0) + 1;

            if (changedIndices.size > 0) {
              plugin.reanalyzeWithDebounce(Array.from(changedIndices));
            }
          }

          // Recompute decorations when metricsVersion changed or doc changed
          if (update.docChanged || update.annotations?.some?.((a) => a.type === RefreshAnnotation) || (this._lastMetricsVersion !== plugin.metricsVersion)) {
            this._lastMetricsVersion = plugin.metricsVersion;
            this.computeDecorations();
          }
        }
        destroy() {}
      },
      {
        decorations: (v) => v.decorations
      }
    );
  }

  /**
   * Read the active file and compute metrics for its paragraphs. The result is
   * cached so the card view can present the same data without recomputing.
   */
  async reanalyze() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    
    // Cancel any ongoing analysis
    if (this._currentAnalysis) {
      this._currentAnalysis.cancelled = true;
    }
    
    // Clear cache immediately when switching files
    if (this.metricsCache && this.metricsCache.file !== file.path) {
      this.metricsCache = null;
      this._subjectEmbeddingCache = null;
    }
    
    const text = await this.app.vault.read(file);
    const paragraphs = splitIntoParagraphs(text);
    
    // Create a new analysis context
    const analysisContext = { cancelled: false, file: file.path };
    this._currentAnalysis = analysisContext;
    
    // Show spinner while we may be calling server/LLM
    this.showBusy(true);
    const metrics = await this.getMetrics(paragraphs).finally(() => {
      // Only hide spinner if this is still the current analysis
      if (this._currentAnalysis === analysisContext) {
        this.showBusy(false);
      }
    });
    
    // Check if this analysis was cancelled
    if (analysisContext.cancelled) {
      return;
    }
    // Persist ranges for stable colouring between live edits
    const snrValues = (metrics || []).map((m) => (typeof m.snr === 'number' ? m.snr : 0));
    const compValues = (metrics || []).map((m) => (typeof m.complexity === 'number' ? m.complexity : 0));
    const ranges = {
      snrMin: snrValues.length ? Math.min(...snrValues) : 0,
      snrMax: snrValues.length ? Math.max(...snrValues) : 1,
      compMin: compValues.length ? Math.min(...compValues) : 0,
      compMax: compValues.length ? Math.max(...compValues) : 1
    };
    this.metricsCache = { file: file.path, metrics, paragraphs, ranges };
    // Signal to the editor decoration plugin that metrics have changed
    this.metricsVersion = (this.metricsVersion || 0) + 1;
    // Refresh decorations immediately after computing metrics
    this._forceRefreshEditors();
    // Update card view if it is open
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof view.renderMetrics === 'function') {
        view.renderMetrics(this.metricsCache);
      }
    }
  }

  resetAnalysisCache(triggerReanalyze = false) {
    try {
      this._subjectEmbeddingCache = null;
      this.metricsCache = null;
      this.metricsVersion = (this.metricsVersion || 0) + 1;
      this._forceRefreshEditors();
      if (triggerReanalyze) {
        this.reanalyze();
      }
    } catch (e) {}
  }

  _forceRefreshEditors() {
    try {
      // Dispatch a no-op with a custom annotation to all markdown editors
      const leaves = this.app.workspace.getLeavesOfType('markdown');
      if (Array.isArray(leaves)) {
        for (const leaf of leaves) {
          const cm = leaf?.view?.editor?.cm;
          if (cm && typeof cm.dispatch === 'function') {
            cm.dispatch({ annotations: RefreshAnnotation.of(true) });
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  showBusy(isBusy) {
    try {
      if (!this._statusBarItem) return;
      this._statusBarItem.style.display = isBusy ? '' : 'none';
    } catch (e) {}
  }

  /**
   * Resolve metrics for a list of paragraphs. If configured to use a remote
   * backend, an HTTP POST request is issued. Should the request fail, the
   * plugin falls back to local heuristics. The returned array always has the
   * same length as the input.
   */
  async getMetrics(paragraphs) {
    const { backendMode, httpEndpoint, topic, apiKey, embeddingModel, chatModel } = this.settings;
    /**
     * Attempt to call the HTTP endpoint. Returns an array of metrics or null on failure.
     */
    const tryHttpEndpoint = async () => {
      if (!httpEndpoint) return null;
      try {
        const res = await fetch(httpEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paragraphs, topic })
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length === paragraphs.length) {
            return data.map((item) => ({
              snr: typeof item.snr === 'number' ? item.snr : 0,
              complexity: typeof item.complexity === 'number' ? item.complexity : 0,
              topic: typeof item.topic === 'number' ? item.topic : 0,
              role: item.role || ''
            }));
          }
        }
        return null;
      } catch (err) {
        return null;
      }
    };
    /**
     * Attempt to compute metrics via the OpenAI API using embeddings and chat completions. Returns metrics or null on failure.
     */
    const tryOpenAi = async () => {
      if (!apiKey) return null;
      try {
        // Determine the topic text: use explicit topic if provided, otherwise use the first paragraph as the subject
        const subject = topic && topic.trim().length > 0 ? topic : paragraphs[0] || '';
        const modelName = embeddingModel || 'text-embedding-3-small';
        // Compute SNR by selected method
        let snrArray = [];
        let llmComplexity = null; // Declare at function scope
        if ((this.settings.snrMethod || 'embedding') === 'embedding') {
          const texts = [subject, ...paragraphs];
          const embs = await fetchOpenAiEmbeddings(apiKey, modelName, texts);
          const subjectEmb = embs[0];
          try { this._subjectEmbeddingCache = { text: subject, model: modelName, embedding: subjectEmb }; } catch (e) {}
          const paraEmbs = embs.slice(1);
          for (let i = 0; i < paraEmbs.length; i++) snrArray.push(cosineSimilarity(subjectEmb, paraEmbs[i]));
        } else {
          // LLM scoring method: ask the chat model to rate each paragraph vs topic
          const messages = [
            {
              role: 'system',
              content:
                'You are a scorer. Given a TOPIC and a list of N numbered PARAGRAPHS, output only a JSON object with the exact shape ' +
                '{"scores":[r1,...,rN], "complexity":[c1,...,cN]}. ' +
                'Each ri is a continuous relevance score in [0,1] (0 off-topic, 1 perfectly on-topic). ' +
                'Each ci is a continuous reading complexity score in [0,1] (0 very easy to read, 1 very complex). ' +
                'Use numbers (no strings), dot as decimal separator, up to 3 decimals. ' +
                'Both arrays must have length exactly N and preserve paragraph order. ' +
                'Do not include the topic itself; score only the numbered paragraphs. ' +
                'Return only the JSON object without code fences or extra text.'
            },
            {
              role: 'user',
              content:
                `Topic: ${subject}\n\nNumber of paragraphs: ${paragraphs.length}\n\nParagraphs (numbered, one per line):\n` +
                paragraphs.map((p, i) => `${i+1}. ${p}`).join('\n') +
                `\n\nReturn strictly a JSON object: {"scores":[${'r,'.repeat(paragraphs.length).slice(0,-1)}], "complexity":[${'c,'.repeat(paragraphs.length).slice(0,-1)}]}`
            }
          ];
          const modelNameChat = chatModel || 'gpt-3.5-turbo';
          const useSchema = /gpt-4o|gpt-5/i.test(modelNameChat);
          const schemaFormat = {
            type: 'json_schema',
            json_schema: {
              name: 'snr_scores',
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  scores: {
                    type: 'array',
                    items: { type: 'number', minimum: 0, maximum: 1 },
                    minItems: paragraphs.length,
                    maxItems: paragraphs.length
                  }
                },
                required: ['scores']
              }
            }
          };
          const responseFormat = useSchema ? schemaFormat : { type: 'json_object' };
          let content = '';
          // Increase token limit to handle longer responses (35 paragraphs * ~10 chars per score * 2 arrays + JSON structure)
          const maxTokens = Math.max(500, paragraphs.length * 20);
          if (/gpt-5/i.test(modelNameChat)) {
            // No special handling for gpt-5 anymore; treat as regular chat path
            const data = await callOpenAiChat(apiKey, modelNameChat, messages, { temperature: 0, responseFormat, maxTokens });
            content = data?.choices?.[0]?.message?.content?.trim() || '';
          } else {
            const data = await callOpenAiChat(apiKey, modelNameChat, messages, { temperature: 0, responseFormat, maxTokens });
            content = data?.choices?.[0]?.message?.content?.trim() || '{}';
          }
          try { console.info('TQA: LLM SNR raw response', { model: modelNameChat, content }); } catch (_) {}
          let parsedOk = false;
          if (content) {
            const obj = parseLlmScoresAndComplexity(content);
            if (obj && (Array.isArray(obj.scores) || Array.isArray(obj.complexity))) {
              snrArray = normalizeArray01(obj.scores || [], paragraphs.length);
              if (Array.isArray(obj.complexity)) {
                llmComplexity = normalizeArray01(obj.complexity, paragraphs.length);
              }
              parsedOk = true;
              try { console.info('TQA: LLM parsed lengths', { scores: snrArray.length, complexity: llmComplexity ? llmComplexity.length : 0, paragraphs: paragraphs.length }); } catch (_) {}
            } else {
              console.warn('TQA: parser returned null; falling back to heuristics for complexity if needed', { raw: content?.slice?.(0, 200) });
            }
          }
          // Fallback to embeddings if all zeros
          if (!parsedOk || snrArray.every((v) => v === 0)) {
            try { console.warn('TQA: Fallback to embeddings (LLM returned zero/invalid scores)', { scores: snrArray, complexity: llmComplexity, paragraphs: paragraphs.length }); } catch (_) {}
            new Notice('LLM SNR scoring failed to return valid data; falling back to embeddings.');
            const texts = [subject, ...paragraphs];
            const embs = await fetchOpenAiEmbeddings(apiKey, modelName, texts);
            const subjectEmb = embs[0];
            try { this._subjectEmbeddingCache = { text: subject, model: modelName, embedding: subjectEmb }; } catch (e) {}
            const paraEmbs = embs.slice(1);
            snrArray = paraEmbs.map((e) => cosineSimilarity(subjectEmb, e));
          }
        }
        // Compute complexity via heuristics for each paragraph (reuse computeHeuristicMetrics to get complexity)
        const heurMetrics = computeHeuristicMetrics(paragraphs, '');
        // Attempt to fetch semantic roles; optional via settings
        let roles = paragraphs.map(() => '');
        if (this.settings.classifyRoles) {
          try {
            roles = await fetchOpenAiRoles(apiKey, chatModel || 'gpt-3.5-turbo', paragraphs);
          } catch (roleErr) {
            roles = paragraphs.map(() => '');
          }
        }
        const results = [];
        for (let i = 0; i < paragraphs.length; i++) {
          const snr = snrArray[i] ?? 0;
          const complexity = (typeof llmComplexity?.[i] === 'number') ? llmComplexity[i] : (heurMetrics[i] ? heurMetrics[i].complexity : 0);
          results.push({ snr, complexity, topic: snr, role: roles[i] });
        }
        return results;
      } catch (err) {
        return null;
      }
    };
    // Heuristic analysis only
    const computeHeuristic = () => {
      const heur = computeHeuristicMetrics(paragraphs, topic);
      return heur.map((m) => Object.assign({}, m, { role: '' }));
    };
    // Determine which analysis to perform based on backendMode
    if (backendMode === 'heuristic') {
      return computeHeuristic();
    }
    if (backendMode === 'server') {
      const metrics = await tryHttpEndpoint();
      if (metrics) return metrics;
      new Notice('HTTP server unreachable or returned invalid data; falling back to heuristic analysis.');
      return computeHeuristic();
    }
    if (backendMode === 'openai') {
      const metrics = await tryOpenAi();
      if (metrics) return metrics;
      if (!apiKey) {
        new Notice('No API key set for OpenAI analysis; falling back to heuristic analysis.');
      } else {
        new Notice('OpenAI API call failed; falling back to heuristic analysis.');
      }
      return computeHeuristic();
    }
    // Auto mode: try HTTP endpoint first, then OpenAI, finally heuristics
    if (backendMode === 'auto') {
      // Try HTTP endpoint if defined
      const serverMetrics = await tryHttpEndpoint();
      if (serverMetrics) return serverMetrics;
      // Try OpenAI if key provided
      const openaiMetrics = await tryOpenAi();
      if (openaiMetrics) return openaiMetrics;
      new Notice('Falling back to heuristic analysis.');
      return computeHeuristic();
    }
    // Default fallback
    return computeHeuristic();
  }

  /**
   * Recompute SNR (and topic/role where applicable) for a subset of paragraph indices.
   * Returns a map index->snr. Uses the currently selected backend mode, but limits
   * computation only to requested paragraphs to keep it light on Enter.
   */
  async recomputeSnrForIndices(paragraphs, indices) {
    const uniqIndices = Array.from(new Set(indices.filter((i) => i >= 0 && i < paragraphs.length)));
    if (uniqIndices.length === 0) return {};
    const result = {};
    const { backendMode, httpEndpoint, topic, apiKey, embeddingModel } = this.settings;
    try {
      if (backendMode === 'server') {
        const bodyParagraphs = uniqIndices.map((i) => paragraphs[i]);
        const res = await fetch(httpEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paragraphs: bodyParagraphs, topic })
        });
        if (res.ok) {
          const data = await res.json();
          for (let k = 0; k < uniqIndices.length; k++) {
            const i = uniqIndices[k];
            const item = data[k] || {};
            result[i] = typeof item.snr === 'number' ? item.snr : 0;
          }
          return result;
        }
      } else if (backendMode === 'openai' || (backendMode === 'auto' && apiKey)) {
        const subject = topic && topic.trim().length > 0 ? topic : paragraphs[0] || '';
        const modelName = embeddingModel || 'text-embedding-3-small';
        // Reuse cached subject embedding if text+model unchanged
        let subjectEmb;
        if (this._subjectEmbeddingCache && this._subjectEmbeddingCache.text === subject && this._subjectEmbeddingCache.model === modelName) {
          subjectEmb = this._subjectEmbeddingCache.embedding;
        } else {
          const subjEmb = await fetchOpenAiEmbeddings(apiKey, modelName, [subject]);
          subjectEmb = subjEmb[0];
          try { this._subjectEmbeddingCache = { text: subject, model: modelName, embedding: subjectEmb }; } catch (e) {}
        }
        const texts = uniqIndices.map((i) => paragraphs[i]);
        const paraEmbs = await fetchOpenAiEmbeddings(apiKey, modelName, texts);
        for (let k = 0; k < uniqIndices.length; k++) {
          const i = uniqIndices[k];
          const sim = cosineSimilarity(subjectEmb, paraEmbs[k]);
          result[i] = sim;
        }
        return result;
      }
    } catch (e) {
      // fall through to heuristic below
    }
    // Heuristic fallback per requested indices
    for (const i of uniqIndices) {
      const words = paragraphs[i].split(/\s+/).filter((w) => w.length > 0);
      const cleaned = words.map((w) => w.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase().trim());
      const uniq = new Set(cleaned.filter((w) => w.length > 0));
      result[i] = words.length > 0 ? uniq.size / words.length : 0;
    }
    return result;
  }

  /**
   * Частичный пересчёт метрик (SNR и Complexity) только для указанных индексов абзацев.
   * Возвращает { snrByIndex: Record<number, number>, complexityByIndex: Record<number, number> }.
   */
  async recomputeMetricsForIndices(paragraphs, indices) {
    const uniqIndices = Array.from(new Set(indices.filter((i) => i >= 0 && i < paragraphs.length)));
    const snrByIndex = {};
    const complexityByIndex = {};
    if (uniqIndices.length === 0) return { snrByIndex, complexityByIndex };

    const { backendMode, httpEndpoint, topic, apiKey, embeddingModel, chatModel } = this.settings;
    // Precompute heuristic complexity for fallback
    const subsetParas = uniqIndices.map((i) => paragraphs[i]);
    const heurSubset = computeHeuristicMetrics(subsetParas, topic || '');
    const applyHeuristics = () => {
      for (let k = 0; k < uniqIndices.length; k++) {
        const i = uniqIndices[k];
        const h = heurSubset[k] || { snr: 0, complexity: 0 };
        snrByIndex[i] = typeof h.snr === 'number' ? h.snr : 0;
        complexityByIndex[i] = typeof h.complexity === 'number' ? h.complexity : 0;
      }
    };

    try {
      if (backendMode === 'server') {
        const res = await fetch(httpEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paragraphs: subsetParas, topic })
        });
        if (res.ok) {
          const data = await res.json();
          for (let k = 0; k < uniqIndices.length; k++) {
            const i = uniqIndices[k];
            const item = data[k] || {};
            snrByIndex[i] = typeof item.snr === 'number' ? item.snr : 0;
            const c = typeof item.complexity === 'number' ? item.complexity : (heurSubset[k] ? heurSubset[k].complexity : 0);
            complexityByIndex[i] = c;
          }
          return { snrByIndex, complexityByIndex };
        }
      } else if (backendMode === 'openai' || (backendMode === 'auto' && apiKey)) {
        const subject = topic && topic.trim().length > 0 ? topic : (paragraphs[0] || '');
        const modelName = embeddingModel || 'text-embedding-3-small';
        if ((this.settings.snrMethod || 'embedding') === 'embedding') {
          // SNR via embeddings, complexity via heuristics
          let subjectEmb;
          if (this._subjectEmbeddingCache && this._subjectEmbeddingCache.text === subject && this._subjectEmbeddingCache.model === modelName) {
            subjectEmb = this._subjectEmbeddingCache.embedding;
          } else {
            const subjEmb = await fetchOpenAiEmbeddings(apiKey, modelName, [subject]);
            subjectEmb = subjEmb[0];
            try { this._subjectEmbeddingCache = { text: subject, model: modelName, embedding: subjectEmb }; } catch (e) {}
          }
          const paraEmbs = await fetchOpenAiEmbeddings(apiKey, modelName, subsetParas);
          for (let k = 0; k < uniqIndices.length; k++) {
            const i = uniqIndices[k];
            snrByIndex[i] = cosineSimilarity(subjectEmb, paraEmbs[k]);
            const c = heurSubset[k] ? heurSubset[k].complexity : 0;
            complexityByIndex[i] = c;
          }
          return { snrByIndex, complexityByIndex };
        } else {
          // LLM scoring for both snr and complexity on the subset
          const messages = [
            {
              role: 'system',
              content:
                'You are a scorer. Given a TOPIC and a list of N numbered PARAGRAPHS, output only a JSON object with the exact shape ' +
                '{"scores":[r1,...,rN], "complexity":[c1,...,cN]}. ' +
                'Each ri is a continuous relevance score in [0,1] (0 off-topic, 1 perfectly on-topic). ' +
                'Each ci is a continuous reading complexity score in [0,1] (0 very easy to read, 1 very complex). ' +
                'Use numbers (no strings), dot as decimal separator, up to 3 decimals. ' +
                'Both arrays must have length exactly N and preserve paragraph order. ' +
                'Do not include the topic itself; score only the numbered paragraphs. ' +
                'Return only the JSON object without code fences or extra text.'
            },
            {
              role: 'user',
              content:
                `Topic: ${subject}\n\nNumber of paragraphs: ${subsetParas.length}\n\nParagraphs (numbered, one per line):\n` +
                subsetParas.map((p, i) => `${i + 1}. ${p}`).join('\n') +
                `\n\nReturn strictly a JSON object: {"scores":[${'r,'.repeat(subsetParas.length).slice(0, -1)}], "complexity":[${'c,'.repeat(subsetParas.length).slice(0, -1)}]}`
            }
          ];
          const modelNameChat = chatModel || 'gpt-3.5-turbo';
          const useSchema = /gpt-4o|gpt-5/i.test(modelNameChat);
          const schemaFormat = {
            type: 'json_schema',
            json_schema: {
              name: 'snr_scores_subset',
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  scores: {
                    type: 'array',
                    items: { type: 'number', minimum: 0, maximum: 1 },
                    minItems: subsetParas.length,
                    maxItems: subsetParas.length
                  },
                  complexity: {
                    type: 'array',
                    items: { type: 'number', minimum: 0, maximum: 1 },
                    minItems: subsetParas.length,
                    maxItems: subsetParas.length
                  }
                },
                required: ['scores', 'complexity']
              }
            }
          };
          const responseFormat = useSchema ? schemaFormat : { type: 'json_object' };
          const maxTokens = Math.max(300, subsetParas.length * 20);
          const data = await callOpenAiChat(apiKey, modelNameChat, messages, { temperature: 0, responseFormat, maxTokens });
          const content = data?.choices?.[0]?.message?.content?.trim() || '';
          const parsed = parseLlmScoresAndComplexity(content) || {};
          const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
          const complexities = Array.isArray(parsed.complexity) ? parsed.complexity : [];
          for (let k = 0; k < uniqIndices.length; k++) {
            const i = uniqIndices[k];
            const s = typeof scores[k] === 'number' ? scores[k] : 0;
            const c = typeof complexities[k] === 'number' ? complexities[k] : (heurSubset[k] ? heurSubset[k].complexity : 0);
            snrByIndex[i] = s;
            complexityByIndex[i] = c;
          }
          // If all zeros, fallback to embeddings for SNR
          if (uniqIndices.every((_, k) => (snrByIndex[uniqIndices[k]] || 0) === 0)) {
            try {
              const texts = [subject, ...subsetParas];
              const embs = await fetchOpenAiEmbeddings(apiKey, embeddingModel || 'text-embedding-3-small', texts);
              const subjectEmb = embs[0];
              for (let k = 1; k < embs.length; k++) {
                const idx = uniqIndices[k - 1];
                snrByIndex[idx] = cosineSimilarity(subjectEmb, embs[k]);
              }
            } catch (e) {}
          }
          return { snrByIndex, complexityByIndex };
        }
      }
    } catch (e) {
      // fall through to heuristic fallback
    }

    // Heuristic fallback for both metrics
    applyHeuristics();
    return { snrByIndex, complexityByIndex };
  }

  /**
   * Activate the card view. If the view is already open it will be brought
   * to the foreground. Otherwise a new pane on the right side is spawned.
   */
  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      if (this.metricsCache) {
        leaves[0].view.renderMetrics(this.metricsCache);
      }
      return;
    }
    await this.app.workspace.getRightLeaf(false).setViewState({
      type: VIEW_TYPE,
      active: true
    });
  }

  /**
   * Attempt to load an API key from a .env file located at the root of the
   * current vault. If the key is already present in settings, this function
   * does nothing. The .env file should contain a line like:
   *   LLM_API_KEY=sk-...
   * The loaded key will be stored in this.settings.apiKey.
   */
  async loadApiKeyFromEnv() {
    if (this.settings.apiKey) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const base = this.app.vault.adapter.basePath;
      const envPath = path.join(base, '.env');
      if (!fs.existsSync(envPath)) return;
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key === 'LLM_API_KEY' && value) {
          this.settings.apiKey = value;
          break;
        }
      }
    } catch (e) {
      // ignore any file errors
    }
  }

  /**
   * Return a background colour interpolated between the configured minimum
   * and maximum colours for signal/noise. The input ratio should be in
   * [0,1]. If the configured colours are missing, fall back to defaults.
   *
   * @param {number} snr A ratio between 0 and 1 representing closeness to topic
   * @returns {string} A CSS hex colour
   */
  getBackgroundColorFor(snr) {
    const t = Math.max(0, Math.min(1, snr || 0));
    const maxC = this.settings.snrMaxColor || DEFAULT_SETTINGS.snrMaxColor || '#d1f9d1';
    // Strict gradient: from theme background color to maxC.
    // Try to read CSS var --background-primary; fall back to computed style or a safe default.
    let baseColorHex = '#ffffff';
    try {
      const rootStyle = getComputedStyle(document.body);
      const varColor = rootStyle.getPropertyValue('--background-primary').trim();
      if (varColor) {
        const rgb = cssColorToRgb(varColor);
        baseColorHex = rgbToHex(rgb);
      } else {
        // try reading editor element background
        const editorEl = document.querySelector('.cm-editor');
        const bg = editorEl ? getComputedStyle(editorEl).backgroundColor : null;
        if (bg) baseColorHex = rgbToHex(cssColorToRgb(bg));
      }
    } catch (e) {}
    // Inverted mapping: high SNR → closer to theme background; low SNR → closer to selected colour
    return interpolateColor(maxC, baseColorHex, t);
  }

  /**
   * Return a text colour interpolated between the configured minimum and
   * maximum colours for complexity. The input ratio should be in [0,1].
   * If the configured colours are missing, fall back to defaults.
   *
   * @param {number} complexity A ratio between 0 and 1 representing complexity
   * @returns {string} A CSS hex colour
   */
  getTextColorFor(complexity) {
    const t = Math.max(0, Math.min(1, complexity || 0));
    const minC = this.settings.complexityMinColor || DEFAULT_SETTINGS.complexityMinColor || '#cccccc';
    const maxC = this.settings.complexityMaxColor || DEFAULT_SETTINGS.complexityMaxColor || '#4c4c4c';
    return interpolateColor(minC, maxC, t);
  }
};