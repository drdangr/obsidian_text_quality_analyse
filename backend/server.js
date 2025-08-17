/*
 * Simple analysis backend for the Text Quality Analyzer.
 *
 * This standalone Node.js script exposes a single HTTP endpoint at
 * `/analyze`. It accepts POST requests with a JSON body containing an
 * array of paragraphs and an optional topic string. It responds with an
 * array of metric objects, each having the properties `snr`, `complexity`
 * and `topic` (all numbers between 0 and 1).
 *
 * Usage:
 *   node server.js
 *
 * The server listens on port 5000 by default. You can change the port by
 * setting the PORT environment variable.
 */

const http = require('http');

// Utility to parse the body of a request as JSON. Resolves the parsed
// object or rejects if parsing fails.
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Protect against overly large requests
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => reject(err));
  });
}

// Heuristic analysis identical to the plugin’s local implementation. See
// `main.js` for detailed documentation. This function accepts an array of
// paragraphs and an optional topic and returns an array of metric objects.
function computeMetrics(paragraphs, topic) {
  const topicLower = (topic || '').toLowerCase();
  const results = [];
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

// Main request handler. Only responds to POST /analyze.
async function handleRequest(req, res) {
  if (req.method === 'POST' && req.url === '/analyze') {
    try {
      const { paragraphs, topic } = await parseRequestBody(req);
      if (!Array.isArray(paragraphs)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paragraphs must be an array of strings' }));
        return;
      }
      const metrics = computeMetrics(paragraphs, topic);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

const port = parseInt(process.env.PORT, 10) || 5000;
const server = http.createServer(handleRequest);
server.listen(port, () => {
  console.log(`Text Quality Analyzer backend running on http://localhost:${port}`);
});