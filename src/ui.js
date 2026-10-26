/**
 * Terminal output.
 *
 * Colors switch off when stdout is not a TTY or NO_COLOR is set, so the same
 * messages read cleanly in CI logs and pipes.
 */

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const CODES = {
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  blue: "\u001b[34m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
};

const paint = (text, color) =>
  enabled ? `${CODES[color]}${text}${CODES.reset}` : text;

export const ok = (m) => console.log(`${paint("[ok]", "green")} ${m}`);
export const warn = (m) => console.log(`${paint("[!]", "yellow")} ${m}`);
export const fail = (m) => console.log(`${paint("[x]", "red")} ${m}`);
export const info = (m) => console.log(`${paint("[>]", "blue")} ${m}`);
export const detail = (m) => console.log(paint(`    ${m}`, "dim"));
export const heading = (m) => console.log(`\n${m}`);
export const rule = (width = 62) => console.log(paint("-".repeat(width), "dim"));
