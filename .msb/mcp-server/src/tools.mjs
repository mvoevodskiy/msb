/**
 * MCP tool catalog for bot data + workspace/project file actions.
 * Handlers: [bot-data](./bot-data.mjs), [workspace-fs](./workspace-fs.mjs).
 */
import {
  botsOverview,
  listBots,
  getBotState,
  listSessions,
  readDiary,
  readTranscriptDay,
  listBotProjects,
} from './bot-data.mjs';
import {
  listFiles,
  readFile,
  writeFile,
  makeDirectory,
  createProject,
} from './workspace-fs.mjs';
import { textResult } from './protocol.mjs';

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const botIdProp = { type: 'string', description: 'ID бота (каталог ~/.msb/bots/<id> или профиль jar1)' };
const scopeProp = {
  type: 'string',
  enum: ['workspace', 'project'],
  description: 'workspace = общий ~/workspace; project = папка в ../projects/<name>',
};
const projectProp = { type: 'string', description: 'Имя проекта (односегментное), обязательно для scope=project' };
const pathProp = { type: 'string', description: 'Относительный путь внутри выбранного корня' };

export function buildTools(env = process.env) {
  return [
    {
      name: 'bots_overview',
      description: 'Сводка по всем ботам профиля: state/env наличие, activeProject, число сессий, модель.',
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async () => textResult(await botsOverview(env)),
    },
    {
      name: 'list_bots',
      description: 'Список всех ботов runtime-профиля (каталоги bots/*).',
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async () => textResult(await listBots(env)),
    },
    {
      name: 'get_bot_state',
      description: 'Прочитать state.json бота (без секретов/.env).',
      inputSchema: objectSchema({ botId: botIdProp }, ['botId']),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ botId }) => textResult(await getBotState(botId, env)),
    },
    {
      name: 'list_sessions',
      description: 'Журнал sessionHistory бота (описания/ID, не native CLI transcripts).',
      inputSchema: objectSchema({ botId: botIdProp }, ['botId']),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ botId }) => textResult(await listSessions(botId, env)),
    },
    {
      name: 'read_diary',
      description: 'Хвост chat-diary.jsonl бота (уже отредактированные summary ответов).',
      inputSchema: objectSchema({
        botId: botIdProp,
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Сколько последних строк (по умолчанию 50)' },
        offset: { type: 'integer', minimum: 0, description: 'Сдвиг от конца' },
      }, ['botId']),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ botId, limit = 50, offset = 0 }) =>
        textResult(await readDiary(botId, { limit, offset }, env)),
    },
    {
      name: 'read_transcript_day',
      description: 'Дневной journal transcripts/YYYY-MM-DD.jsonl бота (preview, не native conversations).',
      inputSchema: objectSchema({
        botId: botIdProp,
        day: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      }, ['botId', 'day']),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ botId, day, limit = 100 }) =>
        textResult(await readTranscriptDay(botId, day, { limit }, env)),
    },
    {
      name: 'list_projects',
      description: 'Список проектов и activeProject выбранного бота; общие пути workspace/projects.',
      inputSchema: objectSchema({ botId: botIdProp }, ['botId']),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ botId }) => textResult(await listBotProjects(botId, env)),
    },
    {
      name: 'list_files',
      description: 'Список файлов в workspace или в проекте.',
      inputSchema: objectSchema({
        scope: scopeProp,
        project: projectProp,
        path: { ...pathProp, description: 'Относительный каталог (по умолчанию .)' },
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ scope = 'workspace', project, path = '.' }) =>
        textResult(await listFiles({ scope, project, path, env })),
    },
    {
      name: 'read_file',
      description: 'Прочитать текстовый файл из workspace или проекта (до 512 KiB). Секретные имена блокируются.',
      inputSchema: objectSchema({
        scope: scopeProp,
        project: projectProp,
        path: pathProp,
      }, ['path']),
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async ({ scope = 'workspace', project, path }) =>
        textResult(await readFile({ scope, project, path, env })),
    },
    {
      name: 'write_file',
      description: 'Создать/перезаписать текстовый файл в workspace или проекте (до 512 KiB).',
      inputSchema: objectSchema({
        scope: scopeProp,
        project: projectProp,
        path: pathProp,
        content: { type: 'string', description: 'Содержимое файла' },
        mkdir: { type: 'boolean', description: 'Создавать родительские каталоги (по умолчанию true)' },
      }, ['path', 'content']),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      handler: async ({ scope = 'workspace', project, path, content, mkdir = true }) =>
        textResult(await writeFile({ scope, project, path, content, mkdir, env })),
    },
    {
      name: 'mkdir',
      description: 'Создать каталог в workspace или проекте.',
      inputSchema: objectSchema({
        scope: scopeProp,
        project: projectProp,
        path: pathProp,
      }, ['path']),
      annotations: { readOnlyHint: false, idempotentHint: true },
      handler: async ({ scope = 'workspace', project, path }) =>
        textResult(await makeDirectory({ scope, project, path, env })),
    },
    {
      name: 'create_project',
      description: 'Создать проект в ../projects/<name> со scaffold memory/knowledge (как Telegram /projects).',
      inputSchema: objectSchema({
        name: { type: 'string', description: 'Односегментное имя проекта' },
      }, ['name']),
      annotations: { readOnlyHint: false, idempotentHint: true },
      handler: async ({ name }) => textResult(await createProject(name, env)),
    },
  ];
}

export const INSTRUCTIONS = [
  'MSB bot-data MCP: данные всех ботов текущего runtime-профиля (msb→~/.msb, jar1→~/.iia).',
  'Чтение: state, sessionHistory, diary/transcripts preview, проекты.',
  'Запись только в общий workspace и проекты; .env, ключи и native CLI conversations недоступны.',
  'Сначала bots_overview или list_bots, затем get_bot_state / list_sessions / list_projects.',
  'Файлы: list_files → read_file / write_file; новый проект — create_project.',
].join(' ');
