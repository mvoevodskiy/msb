/**
 * Read public Telegram widget posts for [collection](./poll.mjs).
 * Exercise through the [poll and storage path](../../tests/monitor-telegram-posts.test.mjs).
 */
const tags = /<!--[\s\S]*?-->|<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>|<(\/?)([a-z][\w:-]*)(?=\s|\/?>)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

function attributes(source) {
  const attrs = new Map();
  for (const [, key, quoted, single, bare] of source.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
    attrs.set(key.toLowerCase(), quoted ?? single ?? bare ?? '');
  }
  return attrs;
}

/** Keep widget ownership while walking nested caption, reply and footer markup. */
export function* readPublicPosts(html, username) {
  const stack = [];
  for (const token of html.matchAll(tags)) {
    const [raw, , slash, name, attrsSource] = token;
    if (!name) continue;
    const tag = name.toLowerCase();
    if (slash) {
      const index = stack.findLastIndex(frame => frame.tag === tag);
      if (index === -1) continue;
      const frame = stack[index];
      stack.length = index;
      if (frame.captionStart !== undefined) {
        frame.post.caption = html.slice(frame.captionStart, token.index);
      }
      if (frame.root && frame.post.date) yield frame.post;
      continue;
    }

    const attrs = attributes(attrsSource);
    const classes = new Set((attrs.get('class') || '').split(/\s+/));
    const parent = stack.at(-1);
    const widget = classes.has('tgme_widget_message');
    const identity = attrs.get('data-post')?.match(/^([\w]+)\/(\d+)$/);
    const root = widget && !parent?.widget
      && identity?.[1].toLowerCase() === username.toLowerCase();
    const post = root ? { identity: identity[0], caption: '' } : widget ? null : parent?.post;
    const frame = { tag, post, root, widget: widget || parent?.widget, dateLink: parent?.dateLink };
    if (post) {
      if (classes.has('tgme_widget_message_text') && !post.caption && !parent?.caption) {
        frame.captionStart = token.index + raw.length;
      }
      frame.caption = frame.captionStart !== undefined || parent?.caption;

      if (tag === 'a') {
        const href = attrs.get('href');
        const linkIdentity = href?.match(/^https:\/\/t\.me\/([\w]+\/\d+)(?:[?#].*)?$/i)?.[1];
        frame.dateLink = classes.has('tgme_widget_message_date')
          && linkIdentity?.toLowerCase() === post.identity.toLowerCase() ? href : null;
      }
      if (tag === 'time' && frame.dateLink && !post.date) {
        const date = Date.parse(attrs.get('datetime'));
        if (Number.isFinite(date)) {
          post.url = frame.dateLink;
          post.date = new Date(date).toISOString();
        }
      }
    }
    if (!voidTags.has(tag) && !raw.endsWith('/>')) stack.push(frame);
  }
}
