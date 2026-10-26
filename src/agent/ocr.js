/**
 * Local OCR for images a model cannot see.
 *
 * Not every provider can process images. Rather than leaving the user with "I cannot
 * see your screenshot", the text inside it can be read locally with tesseract and
 * handed to the model as text. For the common case — a screenshot of an error, a
 * stack trace, a snippet of code, or a chat — that is most of what was wanted.
 *
 * tesseract is optional. When it is not installed, this module reports that and the
 * caller falls back to telling the user plainly. Nothing here is required for the
 * rest of the server to work.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How long one image may take before it is abandoned. */
const TIMEOUT_MS = 20_000;

/** OCR on a huge image is slow and rarely better; Cursor caps images well below this. */
const MAX_BYTES = 12 * 1024 * 1024;

const EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

let cached = null;

/**
 * Is tesseract available?
 *
 * Checked once per process: it does not appear while the server is running.
 *
 * @returns {Promise<boolean>}
 */
export function available() {
  if (cached !== null) return Promise.resolve(cached);

  return new Promise((resolve) => {
    execFile("tesseract", ["--version"], { timeout: 5000 }, (error) => {
      cached = !error;
      resolve(cached);
    });
  });
}

/** Forget the cached answer; used by tests. */
export function resetCache() {
  cached = null;
}

/**
 * Read the text out of one image.
 *
 * @param {{mimeType?: string, data: string}} image base64 payload
 * @returns {Promise<string|null>} the text, or null when it cannot be read
 */
export function readText(image) {
  if (typeof image?.data !== "string" || image.data.length === 0) return Promise.resolve(null);

  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return Promise.resolve(null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "byok-ocr-"));
  const file = path.join(dir, `image${EXTENSIONS[image.mimeType] ?? ".png"}`);

  return new Promise((resolve) => {
    try {
      fs.writeFileSync(file, bytes);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(null);
      return;
    }

    execFile(
      "tesseract",
      [file, "stdout", "-l", "eng", "--psm", "6"],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (error) {
          resolve(null);
          return;
        }
        const text = String(stdout ?? "").trim();
        resolve(text.length > 0 ? text : null);
      },
    );
  });
}

/**
 * Read every image, skipping the ones that yield nothing.
 *
 * @param {Array<{mimeType?: string, data: string}>} images
 * @returns {Promise<Array<{index: number, mimeType: string, text: string}>>}
 */
export async function readAll(images) {
  if (!(await available())) return [];

  const out = [];
  for (let index = 0; index < images.length; index += 1) {
    const text = await readText(images[index]);
    if (text) out.push({ index: index + 1, mimeType: images[index].mimeType ?? "image", text });
  }
  return out;
}

/** One line for `doctor` / `status`. */
export async function describe() {
  return (await available()) ? "tesseract" : "not installed";
}
