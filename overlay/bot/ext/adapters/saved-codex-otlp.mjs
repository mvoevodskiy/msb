/**
 * In-memory receiver owned by a single [saved Codex invocation](./saved-codex.mjs).
 * It binds loopback and retains only [scoped counters](./saved-codex-usage.mjs).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createSavedCodexUsage } from './saved-codex-usage.mjs';

const batchLimit = 4 * 1024 * 1024;

async function readBatch(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim() !== 'application/json') throw new Error('Invalid OTLP content type');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > batchLimit) throw new Error('OTLP batch too large');
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks, bytes);
  const encoding = req.headers['content-encoding'];
  if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: batchLimit });
  else if (encoding && encoding !== 'identity') throw new Error('Unsupported OTLP compression');
  return JSON.parse(body.toString('utf8'));
}

export async function openSavedCodexOtlp() {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(token);
  const usage = createSavedCodexUsage();
  const server = http.createServer({ headersTimeout: 2000, requestTimeout: 3000,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 500 }, async (req, res) => {
    const supplied = Buffer.from(String(req.headers['x-msb-usage-token'] ?? ''));
    if (req.method !== 'POST' || req.url !== '/v1/logs' ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(404, { connection: 'close' }).end();
      req.resume();
      return;
    }
    try {
      usage.ingest(await readBatch(req));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch {
      usage.markIncomplete();
      if (!res.destroyed) res.writeHead(400, { connection: 'close' }).end();
    }
  });
  server.maxConnections = 8;
  server.on('error', usage.markIncomplete);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();

  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/logs';
  const args = ['-c', 'otel.exporter={otlp-http={endpoint=' + JSON.stringify(endpoint) +
    ',protocol="json",headers={x-msb-usage-token=' + JSON.stringify(token) + '}}}',
    '-c', 'otel.log_user_prompt=false', '-c', 'otel.log_agent_responses=false',
    '-c', 'otel.metrics_exporter="none"', '-c', 'otel.trace_exporter="none"'];

  let closing;
  function close() {
    closing ??= new Promise(resolve => {
      const limit = setTimeout(() => {
        usage.markIncomplete();
        server.closeAllConnections();
      }, 1000);
      server.close(() => {
        clearTimeout(limit);
        resolve();
      });
    });
    return closing;
  }
  return { args, close, summarize: usage.summarize };
}
