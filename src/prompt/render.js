/**
 * Render a Cursor prompt tree to text.
 *
 * Cursor builds its prompt as an element tree, not as a string: `createElement`
 * calls with `section`, `p`, `ul`, `li`, `h2`, `x` and `pre` nodes. This turns such a
 * tree into the text the model reads.
 *
 * The rules are copied from the renderer shipped beside the tree in Cursor's own
 * bundle, so the output matches what Cursor sends rather than an approximation:
 *
 *   li        -> "- " + content
 *   section   -> "<title attrs>\ncontent\n</title>", self-closing when empty
 *   br        -> "\n"
 *   h1..h6    -> "## text"
 *   p, ul, ol -> blocks, separated by a blank line
 *   pre       -> content kept verbatim
 *
 * Keeping the renderer separate from the loader means the tree can be inspected and
 * the text asserted without evaluating anything.
 */

/** Node types that start a new block, so the renderer inserts a blank line. */
const BLOCK_TYPES = new Set(["p", "section", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "x", "pre"]);

/** Collapse runs of spaces, keep trailing newlines, trim the edges. */
function normalize(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  const trailing = end === text.length ? "" : text.slice(end);
  return text.replace(/ +/g, " ").trim() + trailing;
}

/**
 * Render a prompt tree to text.
 *
 * @param {object|string|Array} tree what the builder returned
 * @returns {string}
 */
export function render(tree) {
  /** Expand Fragments and components, so callers see plain nodes. */
  function flatten(nodes) {
    const out = [];
    for (const node of nodes) {
      if (node == null || typeof node === "boolean") continue;

      if (Array.isArray(node)) {
        out.push(...flatten(node));
        continue;
      }

      if (typeof node === "object" && "type" in node) {
        if (node.type === "Fragment") {
          const children = node.props?.children;
          out.push(...flatten(Array.isArray(children) ? children : children == null ? [] : [children]));
          continue;
        }
        if (typeof node.type === "function") {
          const built = node.type(node.props);
          out.push(...flatten(Array.isArray(built) ? built : built == null ? [] : [built]));
          continue;
        }
      }

      out.push(node);
    }
    return out;
  }

  /** Serialise the attributes of an `x` or `section` node. */
  function attributes(props) {
    const parts = Object.entries(props ?? {})
      .filter(([key]) => key !== "children" && key !== "key" && key !== "title")
      .filter(([, value]) => value != null)
      .map(([key, value]) =>
        typeof value === "boolean" ? (value ? key : "") : `${key}="${String(value).replace(/"/g, "&quot;")}"`,
      )
      .filter(Boolean);
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
  }

  function renderContent(node) {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return renderBlocks(node);
    // A component the loader could not provide carries no `.type`; treating it as a
    // node would recurse forever.
    if (typeof node === "function") return "";
    return renderNode(node);
  }

  function renderNode(node) {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return renderBlocks(node);
    if (typeof node === "function") return "";

    if (typeof node.type === "function") return renderContent(node.type(node.props));

    const children = node.props?.children;
    switch (node.type) {
      case "p":
      case "Fragment":
        return renderContent(children);

      case "br":
        return "\n";

      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const text = renderContent(children).trim();
        return text.length > 0 ? `${"#".repeat(Number(node.type.slice(1)))} ${text}` : "";
      }

      case "x": {
        const tag = node.props?.tag ?? "x";
        const inner = renderContent(children);
        const attrs = attributes(node.props);
        return inner.trim().length > 0 ? `<${tag}${attrs}>${inner}</${tag}>` : `<${tag}${attrs} />`;
      }

      case "section": {
        const title = String(node.props?.title ?? "").toLowerCase().replace(/\s+/g, "-");
        const inner = renderContent(children);
        const attrs = attributes(node.props);
        return inner.trim().length > 0
          ? `<${title}${attrs}>\n${inner}\n</${title}>`
          : `<${title}${attrs} />`;
      }

      case "pre":
        return renderPre(children);

      case "ul":
        return renderList(children, () => "-");

      case "ol":
        return renderList(children, (index) => `${index}.`);

      case "li":
        return `- ${renderContent(children)}`;

      default:
        return renderContent(children);
    }
  }

  function renderPre(node) {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(renderPre).join("");
    if (typeof node.type === "function") return renderPre(node.type(node.props));
    if (node.type === "Fragment") return renderPre(node.props?.children);
    if (node.type === "br") return "\n";
    return renderPre(node.props?.children);
  }

  function renderList(children, marker) {
    if (children == null) return "";
    const lines = [];
    let counter = 1;

    for (const item of flatten(Array.isArray(children) ? children : [children])) {
      if (item && typeof item === "object" && item.type === "li") {
        const text = renderContent(item.props?.children).trim();
        if (text.length > 0) lines.push(`${marker(counter)} ${text}`);
        counter += 1;
        continue;
      }
      const text = renderNode(item).trim();
      if (text.length > 0) lines.push(text);
    }

    return lines.join("\n");
  }

  /** Blocks separated by a blank line; inline runs stay on one line. */
  function renderBlocks(nodes) {
    const out = [];
    let inline = [];

    const flush = () => {
      if (inline.length === 0) return;
      const text = inline.join("");
      if (text.trim().length > 0) out.push({ content: normalize(text) });
      else if (text.includes("\n")) out.push({ content: text });
      inline = [];
    };

    for (const node of flatten(nodes)) {
      const isBlock =
        node && typeof node === "object" && typeof node.type === "string" && BLOCK_TYPES.has(node.type);

      if (isBlock) {
        flush();
        const rendered = renderNode(node);
        const trimmed = node.type === "pre" ? rendered : rendered.trim();
        if (trimmed.length > 0) out.push({ content: trimmed });
        continue;
      }

      const rendered = renderNode(node);
      if (rendered != null) inline.push(rendered);
    }
    flush();

    if (out.length === 0) return "";

    let text = out[0].content;
    for (let i = 1; i < out.length; i += 1) {
      const previous = out[i - 1];
      const current = out[i];
      const empty = current.content.trim().length === 0;
      const previousEndsWithNewline = previous.content.trim().length > 0 && previous.content.endsWith("\n");
      text += empty || previousEndsWithNewline ? current.content : `\n\n${current.content}`;
    }

    return text.replace(/^\n+/, "").replace(/\n+$/, "");
  }

  return renderContent(tree);
}
