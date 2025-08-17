Text Quality Analyzer — Obsidian Plugin
======================================

This plugin brings paragraph‑level quality analysis to your Obsidian vault. It
provides two core features:

1. **Inline highlighting** in the editor: each paragraph is coloured according to
   its signal‑to‑noise ratio (background colour) and complexity (text colour).
   The background forms a strict gradient from the editor's theme background
   (high SNR) towards a user‑selected highlight colour (low SNR). Text colour
   follows a gradient between two user‑selected colours based on complexity.

2. **Cards view**: a dedicated pane lists all paragraphs in the current note,
   summarising their metrics (signal‑to‑noise, complexity and semantic role).

The analysis can be performed in several ways:

* **Heuristics only** — use simple local calculations to estimate signal‑to‑noise and complexity.
* **OpenAI API** — call OpenAI’s embeddings and chat models directly (requires an API key).
* **HTTP server** — delegate computation to an HTTP endpoint (which can run locally or remotely) that returns metrics for each paragraph.
* **Auto** — try the HTTP server first, then the OpenAI API if a key is provided, and finally fall back to heuristics if neither is available.

See the Settings section below for details on configuring these modes.

Installation
------------

1. Copy the entire `text‑quality‑analyzer` folder into your vault’s
   `.obsidian/plugins` directory. After installation the directory structure
   should look like this:

   ```
   <your‑vault>
   └─ .obsidian
      └─ plugins
         └─ text‑quality‑analyzer
            ├─ manifest.json
            ├─ main.js
            ├─ styles.css
            └─ README.md
   ```

2. Restart Obsidian or reload your plugins (command palette → “Reload core
   plugins”).
3. Enable **Text Quality Analyzer** in *Settings → Community Plugins*.

### API keys and advanced analysis

If you wish to use OpenAI’s models to compute paragraph embeddings (for signal/noise) and
semantic role classification, you’ll need to supply your own API key. The plugin
supports two ways of providing it:

1. Create a `.env` file in the root of your vault with a line like:

   ```
   LLM_API_KEY=sk-…your-openai-key…
   ```

   This file will be read automatically on startup and the key will be stored
   locally (it is not committed to Git if `.env` is ignored).

2. Enter the key manually in the plugin settings under “API key”.

You can also specify which OpenAI models to use for embeddings (default:
`text-embedding-ada-002`) and for semantic role classification (default:
`gpt-3.5-turbo`). When no API key is provided, the plugin falls back to
heuristic analysis.

Usage
-----

Open a Markdown note in edit mode and run the command **Analyze Current Note**
from the command palette (press <kbd>Ctrl</kbd>+<kbd>P</kbd> then type the
command name). Paragraphs will be highlighted immediately. To see metrics in a
list, run **Open Text Quality Cards**. The card view appears in a side pane
listing each paragraph with its signal‑to‑noise ratio, complexity and (when
available) semantic role.

Tip: a ribbon icon in the left sidebar opens the plugin settings.

Settings
--------

Open *Settings → Community Plugins → Text Quality Analyzer* to configure:

* **Analysis mode** — determines how metrics are computed. Options are:
  * *Auto* — try the HTTP server first, then the OpenAI API if a key is provided, otherwise heuristics.
  * *HTTP server* — always call the configured endpoint. If the endpoint is unreachable or returns invalid data, heuristics are used.
  * *OpenAI API* — call OpenAI directly using your API key. If no key is set or the request fails, heuristics are used.
  * *Heuristics only* — never call external services; compute metrics using simple local rules.

* **HTTP Endpoint** — the URL of the analysis service when using the “HTTP server” mode (or when Auto mode detects an available server). Default: `http://localhost:5000/analyze`.

* **API key** — your OpenAI API key. This is required for the “OpenAI API” mode or when Auto mode falls back to OpenAI. You can set it here or in a `.env` file at the root of your vault (see above).

* **Embedding model** — the OpenAI model used to generate embeddings (default: `text-embedding-ada-002`).

* **Chat model** — the OpenAI model used for semantic role classification (default: `gpt-3.5-turbo`).

* **Topic** — an optional phrase to measure how closely each paragraph matches your intended subject. When using OpenAI, SNR is derived as cosine similarity between the topic (or the first paragraph when topic is empty) and paragraph embeddings.

* **Signal/Noise colour** — choose the highlight colour for low SNR. The background interpolates from the editor’s theme background (high SNR) to this colour (low SNR).

* **Complexity colours** — choose two colours to define the gradient for text colour. The left picker corresponds to simple paragraphs, and the right picker corresponds to complex paragraphs.

Notes
-----

* Paragraphs are defined as blocks of text separated by one or more blank
  lines.
* SNR (signal‑to‑noise): heuristics use the ratio of unique tokens to total
  words; OpenAI mode uses cosine similarity between paragraph and the topic (or
  the first paragraph when topic is empty).
* Complexity: computed locally as a combination of LIX and SMOG indices for
  Russian text (SMOG contributes only when there are ≥3 sentences). Both scores
  are normalised to [0,1].
* Colour gradients are produced on the fly without requiring additional CSS.
* When using the HTTP server or OpenAI modes, the plugin automatically falls back to heuristics if the server is unreachable, the API key is missing, or the external calls fail.

Live vs. on‑demand
------------------

* Complexity is updated live as you edit.
* SNR and semantic roles are recomputed on demand via **Analyze Current Note**
  (and automatically when a file is opened). Colour pickers in settings apply
  immediately.
