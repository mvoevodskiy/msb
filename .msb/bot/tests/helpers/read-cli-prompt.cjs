const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');

// Synthetic CLI inputs carry one raw prompt through EOF or one user frame
// while stdin stays open for steering. Return the user text in either case.
module.exports = async function readCliPrompt(input, argv) {
  const formatIndex = argv.indexOf('--input-format');
  if (formatIndex < 0 || argv[formatIndex + 1] !== 'stream-json') {
    input.setEncoding('utf8');
    let prompt = '';
    for await (const chunk of input) prompt += chunk;
    return prompt;
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const { type, message } = JSON.parse(line);
      assert.equal(type, 'user');
      assert.equal(message.role, 'user');
      return message.content.map(part => {
        assert.equal(part.type, 'text');
        assert.equal(typeof part.text, 'string');
        return part.text;
      }).join('');
    }
  } finally {
    lines.close();
  }
  throw Error('Expected a stream-json user frame on fixture stdin');
};
