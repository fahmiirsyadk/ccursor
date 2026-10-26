/**
 * What to do with an attached image.
 *
 * Not every provider can see one. Cursor happily attaches images to any model, and
 * a gateway that does not support them rejects the whole request — which is worse
 * than the image being ignored, because the user loses their text too.
 *
 * So the capability is treated as three states:
 *
 *   true    pass the image through
 *   false   never send it, and say so
 *   unset   try it, and fall back if the provider refuses
 *
 * "Say so" is the part that matters. Dropping an image silently makes the assistant
 * answer "you did not attach anything", which is confusing and false. The model is
 * told what was attached even when it cannot see it, so its answer is accurate.
 */

/** How many images to name in the note before summarising. */
const MAX_NAMED = 3;

/** Magic bytes of the formats a provider will accept. */
const SIGNATURES = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], tail: [0x57, 0x45, 0x42, 0x50] },
  { mime: "image/bmp", bytes: [0x42, 0x4d] },
];

/**
 * Is this really an image?
 *
 * A provider rejects a corrupt payload with an unhelpful error, and the whole turn
 * is lost with it. Checking the magic bytes here turns that into a clear message.
 *
 * @param {{data?: string}} image base64 payload
 * @returns {boolean}
 */
export function looksLikeImage(image) {
  if (typeof image?.data !== "string" || image.data.length < 16) return false;

  let bytes;
  try {
    bytes = Buffer.from(image.data.slice(0, 32), "base64");
  } catch {
    return false;
  }
  if (bytes.length < 4) return false;

  return SIGNATURES.some((signature) => {
    if (!signature.bytes.every((byte, index) => bytes[index] === byte)) return false;
    if (!signature.tail) return true;
    const at = bytes.length - signature.tail.length;
    return at >= 0 && signature.tail.every((byte, index) => bytes[at + index] === byte);
  });
}

/** Split the images into ones that can be sent and ones that cannot. */
export function partition(images) {
  const usable = [];
  const corrupt = [];
  for (const image of images) {
    (looksLikeImage(image) ? usable : corrupt).push(image);
  }
  return { usable, corrupt };
}

/**
 * The note handed to the model when an image cannot be sent.
 *
 * @param {Array} images
 * @param {Array<{index: number, text: string}>} [ocr] text read from the images
 */
export function unseenNote(images, ocr = []) {
  const count = images.length;
  const names = images
    .slice(0, MAX_NAMED)
    .map((image, index) => `image ${index + 1} (${image.mimeType ?? "unknown type"})`)
    .join(", ");
  const rest = count > MAX_NAMED ? `, and ${count - MAX_NAMED} more` : "";

  const header =
    `[${count} image${count === 1 ? "" : "s"} attached: ${names}${rest}. ` +
    "This model cannot process images, so their contents are not available to you.";

  if (ocr.length === 0) {
    return (
      `${header} Tell the user plainly that you cannot see the image, and ask for a ` +
      "description or the relevant text instead. Do not claim no image was attached.]"
    );
  }

  const body = ocr
    .map((entry) => `--- text found in image ${entry.index} ---\n${entry.text}`)
    .join("\n\n");

  return (
    `${header} The text inside ${ocr.length === 1 ? "it" : "them"} was read locally ` +
    `with OCR and is reproduced below. Use it; say that it came from OCR, so the user ` +
    `knows why any garbled characters are garbled. Do not claim no image was attached.]` +
    `\n\n${body}`
  );
}

/** The note handed to the model when the image itself could not be read. */
export function corruptNote(images) {
  return (
    `[${images.length} image${images.length === 1 ? "" : "s"} attached but could not be ` +
    "decoded as an image, so nothing was sent. Tell the user the file may be corrupt or " +
    "in an unsupported format, and ask them to attach it again. Do not claim no image " +
    "was attached.]"
  );
}

/** The notice shown to the user in the chat. */
export function droppedNotice(images, modelId, ocrCount = 0) {
  const count = images.length;
  const what = `${count} image${count === 1 ? "" : "s"} attached, but ${
    modelId || "this model"
  } cannot process images.`;

  if (ocrCount > 0) {
    return `${what} Its text was read locally with OCR and given to the model.`;
  }
  return `${what} Ask for a description, or switch to a model that can see them.`;
}

/**
 * Whether to attempt sending images.
 *
 * @param {object} model entry from providers.json
 * @param {Array} images image blocks for this turn
 * @returns {"send"|"skip"|"try"}
 */
export function imagePolicy(model, images) {
  if (images.length === 0) return "skip";
  if (model?.supportsImages === true) return "send";
  if (model?.supportsImages === false) return "skip";
  return "try";
}

/**
 * Attach the note to the last user turn.
 *
 * A text block is used rather than a system message so it stays attached to the
 * turn the image belongs to, even after the conversation grows.
 */
export function annotate(turns, note) {
  const last = turns[turns.length - 1];
  if (!last) return turns;

  if (Array.isArray(last.content)) {
    last.content = [...last.content, { type: "text", text: note }];
  } else {
    last.content = `${last.content}\n\n${note}`;
  }
  return turns;
}

/** Remove image blocks, keeping every text block. */
export function stripImages(turns) {
  return turns.map((turn) => {
    if (!Array.isArray(turn.content)) return turn;
    const kept = turn.content.filter((block) => block?.type !== "image");
    if (kept.length === turn.content.length) return turn;
    const onlyText = kept.every((block) => block.type === "text");
    return { ...turn, content: onlyText ? kept.map((block) => block.text).join("") : kept };
  });
}
