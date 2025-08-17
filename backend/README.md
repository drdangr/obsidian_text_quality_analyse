Analysis Backend for Text Quality Analyzer
=========================================

This folder contains a simple Node.js server that emulates the remote
functionality of the Text Quality Analyzer plugin. It exposes a single POST
endpoint at `/analyze` that accepts JSON input of the form:

```json
{
  "paragraphs": ["string", "string", ...],
  "topic": "optional topic string"
}
```

The response is a JSON array with one object per paragraph:

```json
[
  { "snr": 0.65, "complexity": 0.41, "topic": 0.0 },
  { "snr": 0.82, "complexity": 0.17, "topic": 1.0 },
  ...
]
```

### Starting the server

The backend requires only the built‑in Node.js libraries (no external
dependencies). To run it, execute:

```bash
cd backend
node server.js
```

By default the server listens on `http://localhost:5000`. You can specify a
different port by setting the `PORT` environment variable:

```bash
PORT=8080 node server.js
```

### Changing the analysis logic

The heuristic used by the server mirrors that in the plugin:

* **Signal‑to‑noise ratio (SNR)** — approximated by the ratio of unique
  alphanumeric tokens to total words.
* **Complexity** — estimated by the fraction of words longer than six
  characters.
* **Topic match** — counts occurrences of the provided topic string in each
  paragraph, normalised to a maximum of 1 at three occurrences.

If you prefer to delegate analysis to a more sophisticated model (for example,
using a hosted LLM), adapt the `computeMetrics` function in `server.js` to
forward the paragraphs and return normalised metrics in the same shape.
