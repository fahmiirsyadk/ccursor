/**
 * Cursor's own prompt code, read from the installed app.
 *
 * The prompt is not a string in Cursor: its bundled `cursor-agent-exec` extension
 * builds it as an element tree, the same tree Cursor's servers assemble. That
 * extension is Cursor's own (`publisher: anysphere`), so reading it keeps the prompt
 * Cursor's text rather than a frozen imitation of it, and nothing is fetched from
 * Cursor's backend.
 *
 * Only the region that declares prompt sections is evaluated, in a sandbox whose
 * unknown names resolve to inert stubs. That keeps the evaluation to the code the
 * prompt actually needs: a dependency this region does not use cannot fail it.
 *
 * The result is memoised per bundle fingerprint, so the workbench is parsed once per
 * process, not once per turn.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/** Where the prompt lives, relative to Cursor's `resources/app`. */
const PROMPT_BUNDLE = path.join("extensions", "cursor-agent-exec", "dist", "main.js");

/**
 * Cursor's app root, from the workbench bundle the server already knows about.
 *
 * @param {string} workbench `<appRoot>/out/vs/workbench/workbench.desktop.main.js`
 * @returns {string}
 */
export function appRootFromWorkbench(workbench) {
  return path.resolve(path.dirname(workbench), "..", "..", "..");
}

/** @param {string} appRoot */
export function promptBundle(appRoot) {
  return path.join(appRoot, PROMPT_BUNDLE);
}

/** Index just past the block that opens at `open`, respecting strings. */
function endOfBlock(source, open) {
  let depth = 0;
  let quote = null;

  for (let i = open; i < source.length; i += 1) {
    const character = source[i];

    if (quote) {
      if (character === "\\") i += 1;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  return source.length;
}

/**
 * The slice of the bundle that builds the prompt.
 *
 * Every function that declares a section is a prompt function; the region from the
 * first to the last contains all of them and their helpers. Reading the boundaries
 * this way survives a rebuild, because the shape (a `title:"..."` in a function) is
 * structural, not positional.
 *
 * @param {string} source the bundle
 * @returns {string} the code to evaluate
 */
export function promptRegion(source) {
  const starts = [];

  for (const match of source.matchAll(/title:"([a-z0-9_]+)"/g)) {
    const before = source.slice(0, match.index);
    const functions = [...before.matchAll(/function\s+([\w$]+)\s*\(/g)];
    if (functions.length > 0) starts.push(functions[functions.length - 1].index);
  }

  if (starts.length === 0) {
    throw new Error("no prompt sections found in cursor-agent-exec; Cursor changed shape");
  }

  return source.slice(Math.min(...starts), endOfBlock(source, Math.max(...starts)));
}

/**
 * The element factory, as the bundle defines it.
 *
 * `createElement(type, props, ...children)`, normalised the way Cursor normalises
 * it: empty children are dropped and `props.children` is mirrored on the node.
 */
function createElement(type, props, ...rest) {
  const { __self, __source, ...own } = props ?? {};
  const children = (own.children ? (Array.isArray(own.children) ? own.children : [own.children]) : rest).filter(
    (child) => child != null && typeof child !== "boolean" && child !== "",
  );

  return {
    type,
    props: { ...own, children: children.length > 0 ? children : undefined },
    children: children.length > 0 ? children : undefined,
  };
}

/**
 * Names the prompt code reaches for that this region does not define.
 *
 * They resolve to a callable, constructable, iterable stub: a section that reads an
 * unknown helper renders as nothing instead of failing the whole prompt.
 */
function createStub() {
  return new Proxy(function () {}, {
    get(_target, key) {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "length") return 0;
      return stub;
    },
    apply: () => stub,
    construct: () => stub,
    has: () => true,
  });
}

let stub;

/**
 * The one module the prompt code asks for by id.
 *
 * `c9.kM` decides whether a workspace path is a Cursor-managed worktree
 * (`…/.cursor/worktrees/…`), and the prompt prints a "stay inside it" note when it
 * is. Left as a stub the call returns a truthy object, so the note would appear for
 * every workspace. The implementation is copied from the module in the bundle.
 *
 * The id is build-specific, like the function names this file already depends on. If
 * Cursor renumbers it the note can appear for a normal workspace; it is a
 * restriction on where to edit, not a capability, so that failure is conservative
 * rather than wrong in a way that loses work.
 */
const KNOWN_MODULES = {
  68388: {
    kM: (value) => String(value).replace(/\\/g, "/").includes(".cursor/worktrees"),
  },
};

/**
 * The bundle's `require`, so a known module resolves and everything else is a stub.
 *
 * It stays callable and property-safe: code in the region also reads `r.d`, `r.r`
 * and `r.n` to register exports.
 */
function createRequire(stub) {
  const load = (id) => KNOWN_MODULES[id] ?? stub;

  return new Proxy(load, {
    get(target, key) {
      if (key === "then") return undefined;
      if (key === "d" || key === "r" || key === "n" || key === "t") return () => {};
      return stub;
    },
    apply: (_target, _thisArg, args) => load(args[0]),
    construct: () => stub,
    has: () => true,
  });
}

/** Evaluate the prompt region and hand back its scope. */
function evaluate(code) {
  stub = createStub();

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    process: { env: {} },
    r: createRequire(stub),
    Kz: createElement,
    Yz: createElement,
    Vz: (props) => createElement("Fragment", props),
    // Element names the prompt text interpolates (`<${Qz}>` is <system_notification>).
    // They are defined beside the prompt code, outside the slice.
    Qz: "system_notification",
    Xz: "</system_notification>",
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(
    new Proxy(sandbox, {
      has: () => true,
      get(target, key) {
        if (key in target) return target[key];
        if (key === Symbol.unscopables) return undefined;
        return stub;
      },
    }),
  );

  try {
    vm.runInContext(code, context, { timeout: 30_000 });
  } catch (error) {
    // The bundle is one enormous line; a stack trace would dump all of it.
    throw new Error(`Cursor's prompt code did not evaluate: ${error.message}`);
  }

  return context;
}

/** One evaluation per bundle version. */
const loaded = new Map();

/**
 * Cursor's prompt scope for an install.
 *
 * @param {string} appRoot Cursor's `resources/app`
 * @returns {{context: object, bundle: string}}
 */
export function load(appRoot) {
  const bundle = promptBundle(appRoot);
  const stat = fs.statSync(bundle);
  const key = `${bundle}:${stat.size}:${stat.mtimeMs}`;

  const cached = loaded.get(key);
  if (cached) return cached;

  const context = evaluate(promptRegion(fs.readFileSync(bundle, "utf8")));
  const entry = { context, bundle };
  loaded.set(key, entry);
  return entry;
}

/** Forget every evaluated bundle. Tests use this to switch installs. */
export function reset() {
  loaded.clear();
}
