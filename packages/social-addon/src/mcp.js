import { createInterface } from 'node:readline';

// Newest first. A client asking for an older revision gets that revision back (the tool surface is the same).
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 1024 * 1024;

/** @typedef {{name:string, description:string, inputSchema:object,
 *   call:(args:object)=>Promise<{value:unknown, isError?:boolean}>}} Tool */

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Answer one decoded JSON-RPC message. Returns the response, or null for notifications.
 * @param {{tools:Tool[], info:{name:string, version:string}, instructions?:string}} server */
export async function handleRpc(server, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = msg;
  const notification = id === undefined;
  if (notification) return null;
  if (typeof id !== 'string' && !Number.isSafeInteger(id)) return rpcError(null, -32600, 'Invalid request id');
  const ok = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: server.info,
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: server.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = server.tools.find(t => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, 'Unknown tool');
      const args = params.arguments ?? {};
      try {
        const { value, isError } = await tool.call(args);
        return ok({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });
      } catch (error) {
        // Tool failures are results the agent can read, not protocol errors.
        return ok({ content: [{ type: 'text', text: JSON.stringify({ error: String(error?.message ?? error) }) }], isError: true });
      }
    }
    default: return rpcError(id, -32601, 'Method not found');
  }
}

/** Serve MCP over newline-delimited JSON-RPC (the MCP stdio transport). Resolves when input ends.
 * @param {{tools:Tool[], info:{name:string, version:string}, instructions?:string,
 *   input?:NodeJS.ReadableStream, output?:NodeJS.WritableStream}} options */
export async function serveMcp({ tools, info, instructions, input = process.stdin, output = process.stdout }) {
  const server = { tools, info, instructions };
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = value => { if (value) output.write(JSON.stringify(value) + '\n'); };
  const running = new Set();
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > MAX_LINE) { write(rpcError(null, -32600, 'Message too large')); continue; }
    let msg;
    try { msg = JSON.parse(line); } catch { write(rpcError(null, -32700, 'Parse error')); continue; }
    if (Array.isArray(msg)) { write(rpcError(null, -32600, 'Batches are not supported')); continue; }
    // Calls run concurrently; each answer carries its request id.
    const job = handleRpc(server, msg).then(write, () => write(rpcError(msg?.id ?? null, -32603, 'Internal error')));
    running.add(job);
    job.finally(() => running.delete(job));
  }
  await Promise.all(running);
}
