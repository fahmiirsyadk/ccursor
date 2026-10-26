/**
 * Images, and what happens when a model cannot see them.
 *
 * Two paths matter: a vision model receives the image, and a text-only model
 * receives the text that was read out of it locally. The second is the common case
 * here, because Cursor attaches images to whatever model is selected.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import * as ocr from "../src/agent/ocr.js";
import {
  annotate,
  droppedNotice,
  imagePolicy,
  looksLikeImage,
  partition,
  stripImages,
  unseenNote,
} from "../src/agent/vision.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-vision-"));
const savedPath = process.env.PATH;

after(() => {
  process.env.PATH = savedPath;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A 1x1 PNG. Contents do not matter: OCR is stubbed in these tests. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const image = () => ({ type: "image", mimeType: "image/png", data: PNG.toString("base64") });

/** Put a fake tesseract on PATH that prints a fixed answer. */
function installFakeTesseract(output) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const file = path.join(dir, "tesseract");
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tesseract 5.0.0"; exit 0; fi\necho "${output}"\n`);
  fs.chmodSync(file, 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  ocr.resetCache();
  return dir;
}

/** Remove tesseract from PATH entirely. */
function installNoTesseract() {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
  process.env.PATH = dir;
  ocr.resetCache();
  return dir;
}

describe("image policy", () => {
  it("sends to a model that can see", () => {
    assert.equal(imagePolicy({ supportsImages: true }, [image()]), "send");
  });

  it("skips for a model that cannot", () => {
    assert.equal(imagePolicy({ supportsImages: false }, [image()]), "skip");
  });

  it("tries when the capability is unknown", () => {
    assert.equal(imagePolicy({}, [image()]), "try");
  });

  it("skips when there is no image", () => {
    assert.equal(imagePolicy({ supportsImages: true }, []), "skip");
  });
});

describe("notes", () => {
  it("tells the model an image was attached when it cannot see it", () => {
    const note = unseenNote([image()]);
    assert.match(note, /1 image attached/);
    assert.match(note, /cannot process images/);
    assert.match(note, /Do not claim no image was attached/);
  });

  it("includes OCR text when it was read", () => {
    const note = unseenNote([image()], [{ index: 1, text: "Error: connection refused" }]);
    assert.match(note, /text found in image 1/);
    assert.match(note, /Error: connection refused/);
    assert.match(note, /came from OCR/);
  });

  it("says OCR was used in the notice the user sees", () => {
    assert.match(droppedNotice([image()], "vendor/model", 1), /read locally with OCR/);
    assert.match(droppedNotice([image()], "vendor/model", 0), /switch to a model/);
  });
});

describe("turn content", () => {
  it("appends the note to a text turn", () => {
    const turns = [{ role: "user", content: "what is this?" }];
    annotate(turns, "NOTE");
    assert.equal(turns[0].content, "what is this?\n\nNOTE");
  });

  it("appends the note to a block turn", () => {
    const turns = [{ role: "user", content: [{ type: "text", text: "hi" }, image()] }];
    annotate(turns, "NOTE");
    assert.equal(turns[0].content.at(-1).text, "NOTE");
  });

  it("strips images and keeps the text", () => {
    const turns = [
      { role: "user", content: [{ type: "text", text: "look" }, image()] },
      { role: "assistant", content: "ok" },
    ];

    const out = stripImages(turns);
    assert.equal(out[0].content, "look", "text-only turns collapse back to a string");
    assert.equal(out[1].content, "ok");
  });

  it("keeps a block turn when something other than text remains", () => {
    const turns = [
      {
        role: "assistant",
        content: [{ type: "text", text: "reading" }, { type: "tool_use", id: "1", name: "Read", input: {} }],
      },
    ];

    const out = stripImages(turns);
    assert.ok(Array.isArray(out[0].content));
    assert.equal(out[0].content.length, 2);
  });
});

describe("OCR", () => {
  beforeEach(() => {
    installNoTesseract();
  });

  it("reports tesseract as missing when it is not on PATH", async () => {
    assert.equal(await ocr.available(), false);
    assert.deepEqual(await ocr.readAll([image()]), []);
  });

  it("reads text when tesseract is present", async () => {
    installFakeTesseract("Error: connection refused");
    assert.equal(await ocr.available(), true);

    const out = await ocr.readAll([image()]);
    assert.equal(out.length, 1);
    assert.equal(out[0].index, 1);
    assert.match(out[0].text, /connection refused/);
  });

  it("skips an image that yields no text", async () => {
    installFakeTesseract("");
    assert.deepEqual(await ocr.readAll([image()]), []);
  });

  it("ignores a malformed payload", async () => {
    installFakeTesseract("text");
    assert.equal(await ocr.readText({ mimeType: "image/png", data: "" }), null);
  });
});

describe("image bytes", () => {
  it("accepts a real PNG", () => {
    assert.equal(looksLikeImage(image()), true);
  });

  it("accepts a real JPEG", async () => {
    const { execFileSync } = await import("node:child_process");
    // ImageMagick is not guaranteed; a hand-built JPEG header is enough for a
    // signature check, which is all this function claims to do.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 0)]);
    assert.equal(looksLikeImage({ data: jpeg.toString("base64") }), true);
    assert.equal(typeof execFileSync, "function");
  });

  it("cannot tell a signed-but-corrupt image from a good one", () => {
    // The check reads magic bytes, it does not decode. A payload that starts with a
    // PNG header but has a broken body passes here and is caught by the provider
    // instead, which is why the retry-without-images path exists.
    const signed = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 0),
    ]);
    assert.equal(looksLikeImage({ data: signed.toString("base64") }), true);
  });

  it("rejects text pretending to be an image", () => {
    assert.equal(looksLikeImage({ data: Buffer.from("this is not an image at all").toString("base64") }), false);
  });

  it("rejects an empty or short payload", () => {
    assert.equal(looksLikeImage({ data: "" }), false);
    assert.equal(looksLikeImage({}), false);
    assert.equal(looksLikeImage(null), false);
  });

  it("splits usable images from corrupt ones", () => {
    const out = partition([
      image(),
      { type: "image", mimeType: "image/png", data: Buffer.from("garbage garbage garbage").toString("base64") },
    ]);

    assert.equal(out.usable.length, 1);
    assert.equal(out.corrupt.length, 1);
  });
});
