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
const { RangeSetBuilder } = require('@codemirror/state');

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
  /** Name of the embedding model to use (e.g. text-embedding-ada-002). */
  embeddingModel: 'text-embedding-ada-002',
  /** Name of the chat model used for semantic role classification. */
  chatModel: 'gpt-3.5-turbo'
  ,
  /** Color used for the lowest signal‑to‑noise (far from topic). Represented as a CSS hex string. */
  snrMinColor: '#f9d1d1',
  /** Color used for the highest signal‑to‑noise (close to topic). Represented as a CSS hex string. */
  snrMaxColor: '#d1f9d1',
  /** Color used for the lowest complexity (simple text). Represented as a CSS hex string. */
  complexityMinColor: '#cccccc',
  /** Color used for the highest complexity (complex text). Represented as a CSS hex string. */
  complexityMaxColor: '#4c4c4c'
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
    const longWords = cleaned.filter((w) => w.length > 6);
    const complexity = words.length > 0 ? longWords.length / words.length : 0;
    let topicScore = 0;
    if (topicLower.length > 0) {
      const occur = para.toLowerCase().split(topicLower).length - 1;
      topicScore = occur > 0 ? Math.min(1, occur / 3) : 0;
    }
    results.push({ snr, complexity, topic: topicScore });
  }
  return results;
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

/**
 * Request vector embeddings for an array of texts via the OpenAI API. The
 * returned embeddings are arrays of floats. If the API call fails, an error
 * will be thrown. The model name must be specified (e.g. 'text-embedding-ada-002').
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
      // Title
      card.createEl('h4', { text: `Paragraph ${idx + 1}` });
      // Snippet
      const snippet = paragraphs[idx].length > 200 ? paragraphs[idx].slice(0, 200) + '…' : paragraphs[idx];
      card.createEl('p', { text: snippet });
      // Metrics list
      const list = card.createEl('ul');
      list.createEl('li', { text: `Signal‑to‑noise: ${m.snr.toFixed(2)}` });
      list.createEl('li', { text: `Complexity: ${m.complexity.toFixed(2)}` });
      // Show semantic role if available
      if (m.role && m.role.trim()) {
        list.createEl('li', { text: `Role: ${m.role}` });
      }
      // Link to jump to the paragraph in the editor
      const link = card.createEl('a', { text: 'Go to paragraph', href: '#' });
      link.onclick = (ev) => {
        ev.preventDefault();
        this.jumpToParagraph(idx);
      };
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
      .setDesc('Name of the embedding model (e.g. text-embedding-ada-002).')
      .addText((text) => {
        text.setPlaceholder('text-embedding-ada-002');
        text.setValue(this.plugin.settings.embeddingModel || 'text-embedding-ada-002');
        text.onChange(async (value) => {
          this.plugin.settings.embeddingModel = value.trim() || 'text-embedding-ada-002';
          await this.plugin.saveSettings();
        });
      });

    // Chat model selector
    new Setting(containerEl)
      .setName('Chat model')
      .setDesc('Name of the model for semantic role classification (e.g. gpt-3.5-turbo).')
      .addText((text) => {
        text.setPlaceholder('gpt-3.5-turbo');
        text.setValue(this.plugin.settings.chatModel || 'gpt-3.5-turbo');
        text.onChange(async (value) => {
          this.plugin.settings.chatModel = value.trim() || 'gpt-3.5-turbo';
          await this.plugin.saveSettings();
        });
      });

    // Colour pickers for signal-to-noise gradient (background)
    new Setting(containerEl)
      .setName('Signal/Noise colours')
      .setDesc('Choose gradient colours for background (topic closeness). Left: far, Right: close')
      .addColorPicker((picker) => {
        picker.setValue(this.plugin.settings.snrMinColor || '#f9d1d1');
        picker.onChange(async (value) => {
          this.plugin.settings.snrMinColor = value;
          await this.plugin.saveSettings();
          // Refresh decorations on-the-fly when colour changes
          this.plugin.metricsVersion = (this.plugin.metricsVersion || 0) + 1;
          try {
            const cm = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.cm;
            if (cm && typeof cm.dispatch === 'function') cm.dispatch({ effects: [] });
          } catch (e) {}
        });
      })
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
      callback: () => this.reanalyze()
    });
    // Recompute metrics whenever the active file changes
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.reanalyze();
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
            plugin.reanalyze();
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

          // Normalisation across all paragraphs: map min->0, max->1
          const snrValues = (metrics || []).map((m) => (typeof m.snr === 'number' ? m.snr : 0));
          const complexityValues = (metrics || []).map((m) => (typeof m.complexity === 'number' ? m.complexity : 0));
          const snrMin = snrValues.length ? Math.min(...snrValues) : 0;
          const snrMax = snrValues.length ? Math.max(...snrValues) : 1;
          const compMin = complexityValues.length ? Math.min(...complexityValues) : 0;
          const compMax = complexityValues.length ? Math.max(...complexityValues) : 1;
          const normalize = (value, min, max) => {
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
          // Recompute when the document changes or when plugin metricsVersion changed
          if (update.docChanged || (this._lastMetricsVersion !== plugin.metricsVersion)) {
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
    const text = await this.app.vault.read(file);
    const paragraphs = splitIntoParagraphs(text);
    const metrics = await this.getMetrics(paragraphs);
    this.metricsCache = { file: file.path, metrics, paragraphs };
    // Signal to the editor decoration plugin that metrics have changed
    this.metricsVersion = (this.metricsVersion || 0) + 1;
    // Refresh decorations immediately after computing metrics
    if (this.decorationsExtension && this.decorationsExtension.value) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.cm;
      // The CodeMirror instance will refresh when doc changes; we manually trigger
      // by dispatching a no‑op transaction. If cm is undefined (older versions),
      // decorations will update on the next edit.
      try {
        // Trigger a lightweight update; decorations plugin will also detect
        // the metricsVersion change and recompute colours.
        view.dispatch({ effects: [] });
      } catch (e) {
        // ignore
      }
    }
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
        // Request embeddings for the subject and all paragraphs at once
        const texts = [subject, ...paragraphs];
        const embs = await fetchOpenAiEmbeddings(apiKey, embeddingModel || 'text-embedding-ada-002', texts);
        const subjectEmb = embs[0];
        const paraEmbs = embs.slice(1);
        // Compute complexity via heuristics for each paragraph (reuse computeHeuristicMetrics to get complexity)
        const heurMetrics = computeHeuristicMetrics(paragraphs, '');
        // Attempt to fetch semantic roles; if it fails, default to empty string
        let roles = [];
        try {
          roles = await fetchOpenAiRoles(apiKey, chatModel || 'gpt-3.5-turbo', paragraphs);
        } catch (roleErr) {
          roles = paragraphs.map(() => '');
        }
        const results = [];
        for (let i = 0; i < paragraphs.length; i++) {
          const sim = cosineSimilarity(subjectEmb, paraEmbs[i]);
          const complexity = heurMetrics[i] ? heurMetrics[i].complexity : 0;
          results.push({ snr: sim, complexity, topic: sim, role: roles[i] });
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
    const minC = this.settings.snrMinColor || DEFAULT_SETTINGS.snrMinColor || '#f9d1d1';
    const maxC = this.settings.snrMaxColor || DEFAULT_SETTINGS.snrMaxColor || '#d1f9d1';
    return interpolateColor(minC, maxC, t);
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