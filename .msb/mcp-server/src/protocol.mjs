/**
 * Minimal MCP stdio transport: newline-delimited JSON-RPC.
 * Spec: one JSON message per line; stdout is protocol-only; logs → stderr.
 */
import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'msb-bot-data', version: '0.1.0' };

export function textResult(payload, { isError = false } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

export function createMcpHost({ tools, instructions }) {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  async function handleRequest(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions,
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
          })),
        },
      };
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = toolMap.get(name);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          result: textResult({ error: `Unknown tool: ${name}` }, { isError: true }),
        };
      }
      try {
        const result = await tool.handler(args);
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          result: textResult({
            error: String(error.message || error),
            code: error.code || null,
          }, { isError: true }),
        };
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  async function handleMessage(message, write) {
    if (!message || typeof message !== 'object') return;
    if (message.method && message.id === undefined) {
      // notifications/initialized and other notifications — no response
      return;
    }
    if (message.method && message.id !== undefined) {
      const response = await handleRequest(message);
      write(response);
    }
  }

  function serve({ stdin = process.stdin, stdout = process.stdout } = {}) {
    const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    const write = (message) => {
      stdout.write(`${JSON.stringify(message)}\n`);
    };
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${error.message}` },
        });
        return;
      }
      try {
        await handleMessage(message, write);
      } catch (error) {
        if (message.id !== undefined) {
          write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: String(error.message || error) },
          });
        }
      }
    });
    rl.on('close', () => {
      // Client closed stdin — exit promptly per stdio binding.
      process.exit(0);
    });
    return { rl };
  }

  return { handleRequest, handleMessage, serve, tools };
}
