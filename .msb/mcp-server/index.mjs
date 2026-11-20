#!/usr/bin/env node
/**
 * stdio MCP entry for external tools (Cursor IDE и др.).
 * Модули: [tools](./src/tools.mjs), [protocol](./src/protocol.mjs).
 * Профиль/корни — через HOME, MSB_RUNTIME_PROFILE, MSB_RUNTIME_ROOT, MSB_WORKSPACE_DIR.
 */
import { createMcpHost } from './src/protocol.mjs';
import { buildTools, INSTRUCTIONS } from './src/tools.mjs';

const host = createMcpHost({
  tools: buildTools(process.env),
  instructions: INSTRUCTIONS,
});

console.error('[msb-mcp] bot-data server on stdio');
host.serve();
