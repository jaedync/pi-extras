// A stand-in for OpenAI's Computer Use client: newline-delimited MCP over stdio,
// including the per-app approval it requests before the first get_app_state.
import { createInterface } from 'node:readline';

const approved = new Set();
const waiting = new Map();
let nextId = 1;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const ask = (method, params) => new Promise((resolve) => {
  const id = `ask-${nextId++}`;
  waiting.set(id, resolve);
  send({ id, method, params });
});
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

async function call(name, args) {
  if (name === 'list_apps') return text('Finder — /System/Library/CoreServices/Finder.app/ — com.apple.finder [running]');
  if (name === 'crash') process.exit(3);
  if (name === 'slow') { await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000))); return text('slow done'); }
  if (!approved.has(args.app)) {
    const answer = await ask('elicitation/create', { message: `Allow ChatGPT to use ${args.app}?`, requestedSchema: { type: 'object', properties: {} }, _meta: { persist: ['always'] } });
    if (answer.result?.action !== 'accept') return text(`User denied ${args.app}`, true);
    approved.add(args.app);
    if (answer.result?._meta?.persist) process.stderr.write(`persist=${answer.result._meta.persist}\n`);
  }
  if (name === 'get_app_state') {
    return { content: [{ type: 'text', text: `App=${args.app}\n0 window\n\t1 button OK` }, { type: 'image', data: Buffer.from(`png:${args.app}`).toString('base64'), mimeType: 'image/png' }] };
  }
  return text(`${name} ${JSON.stringify(args)}`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Computer Use', version: 'fake' } } });
  else if (message.method === 'tools/call') send({ id: message.id, result: await call(message.params.name, message.params.arguments ?? {}) });
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
