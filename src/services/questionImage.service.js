/**
 * WHAT: Validates optional teacher-authored pictures for papers and missions.
 * WHY: All formats need the same bounded, accessible raster-image contract.
 * HOW: Check encoded size, raster signatures and a required description.
 */
function createError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
function normalizeQuestionImage(item) {
  const imageDataUrl = String(item?.imageDataUrl || "");
  const imageDescription = String(item?.imageDescription || "").trim();
  // WHY: Raster-only, bounded data avoids remote tracking, SVG scripts and
  // oversized Mongo documents. Never trust the file extension alone.
  if (imageDescription.length > 6000) throw createError(400, "Image description is too long.");
  if (!imageDataUrl) return { imageDataUrl: "", imageDescription };
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageDataUrl);
  if (!match || imageDataUrl.length > 700000) throw createError(400, "Use a PNG or JPEG image up to 512 KB.");
  const bytes = Buffer.from(match[2], "base64");
  const valid = match[1] === "png"
    ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid || bytes.length > 512 * 1024 || bytes.toString("base64") !== match[2]) {
    throw createError(400, "The image content must be a valid PNG or JPEG up to 512 KB.");
  }
  if (!imageDescription) throw createError(400, "Add an image description for students using assistive technology.");
  return { imageDataUrl, imageDescription };
}

function normalizeMissionPictures(draft) {
  if (!draft || typeof draft !== "object") return draft;
  const direct = Array.isArray(draft.sentences);
  const sentences = direct ? draft.sentences : draft.builder?.sentences;
  if (!Array.isArray(sentences)) return draft;
  assertPictureBudget(sentences);
  const normalized = sentences.map(sentence => ({
    ...sentence, ...normalizeQuestionImage(sentence),
  }));
  // WHY: Older AI drafts keep the same sentences under builder; retain that shape.
  return direct ? { ...draft, sentences: normalized }
    : { ...draft, builder: { ...draft.builder, sentences: normalized } };
}
function assertPictureBudget(items) {
  // WHY: Keep text and pictures safely below MongoDB's document limit.
  if (items.reduce((sum, item) => sum + String(item?.imageDataUrl || "").length, 0) > 8 * 1024 * 1024) {
    throw createError(400, "Pictures in one mission must total less than 6 MB before encoding.");
  }
}
module.exports = { normalizeQuestionImage, normalizeMissionPictures, assertPictureBudget };
