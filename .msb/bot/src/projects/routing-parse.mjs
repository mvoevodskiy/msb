/**
 * Constrained YAML/JSON reader for project routing settings. No external YAML dep.
 * Accepts JSON objects and a map-only YAML subset (scalars, nested maps, # comments).
 * Callers: [routing-load](./routing-load.mjs). Checks: [project-routing](../../tests/project-routing.test.mjs).
 */

function scalar(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function lineIndent(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseRoutingSettingsText(text) {
  if (typeof text !== 'string') throw Object.assign(new Error('пустой файл настроек'), { code: 'ROUTING_PARSE' });
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw Object.assign(new Error('пустой файл настроек'), { code: 'ROUTING_PARSE' });
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); }
    catch (error) {
      throw Object.assign(new Error('невалидный JSON в настройках: ' + error.message), { code: 'ROUTING_PARSE' });
    }
  }
  return parseYamlMaps(trimmed);
}

function parseYamlMaps(text) {
  const lines = text.split(/\r?\n/).map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return true;
    })
    .map(({ line, index }) => {
      const hash = line.search(/(^|\s)#/);
      const raw = hash >= 0 ? line.slice(0, hash).trimEnd() : line;
      return { raw, index };
    })
    .filter(({ raw }) => raw.trim() !== '');

  let pos = 0;
  function parseBlock(minIndent) {
    const object = {};
    let saw = false;
    while (pos < lines.length) {
      const { raw, index } = lines[pos];
      const indent = lineIndent(raw);
      if (indent < minIndent) break;
      if (indent > minIndent && saw) {
        throw Object.assign(new Error(`неожиданный отступ в строке ${index}`), { code: 'ROUTING_PARSE' });
      }
      if (indent !== minIndent) {
        throw Object.assign(new Error(`неожиданный отступ в строке ${index}`), { code: 'ROUTING_PARSE' });
      }
      const body = raw.slice(indent);
      const sep = body.indexOf(':');
      if (sep < 0) throw Object.assign(new Error(`ожидался ключ:значение в строке ${index}`), { code: 'ROUTING_PARSE' });
      const key = body.slice(0, sep).trim();
      if (!key || /\s/.test(key)) {
        throw Object.assign(new Error(`неверный ключ в строке ${index}`), { code: 'ROUTING_PARSE' });
      }
      const rest = body.slice(sep + 1).trim();
      pos += 1;
      saw = true;
      if (rest !== '') {
        object[key] = scalar(rest);
        continue;
      }
      if (pos >= lines.length || lineIndent(lines[pos].raw) <= indent) {
        object[key] = {};
        continue;
      }
      object[key] = parseBlock(lineIndent(lines[pos].raw));
    }
    return object;
  }

  const root = parseBlock(lineIndent(lines[0].raw));
  if (pos !== lines.length) {
    throw Object.assign(new Error(`лишние строки после корня (стр. ${lines[pos].index})`), { code: 'ROUTING_PARSE' });
  }
  return root;
}
