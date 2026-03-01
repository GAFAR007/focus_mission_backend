/**
 * WHAT:
 * sourceExtraction.service turns uploaded source documents and scanned images
 * into clean text that teacher AI flows can use for planning and drafting.
 * WHY:
 * Teachers should be able to start from the real booklet or scan instead of
 * manually retyping units before asking Groq to plan or draft missions.
 * HOW:
 * Detect the uploaded file type, extract text with the matching parser or OCR
 * engine, normalize the result, and return stable source metadata plus text.
 */
const path = require("path");
const mammoth = require("mammoth");
const { PDFParse } = require("pdf-parse");
const Tesseract = require("tesseract.js");

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getExtension(fileName) {
  return path.extname(String(fileName || "")).toLowerCase();
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, " ")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return normalizeExtractedText(result.text);
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeExtractedText(result.value);
}

function extractPlainText(buffer) {
  return normalizeExtractedText(buffer.toString("utf8"));
}

async function extractImageText(buffer) {
  try {
    const result = await Tesseract.recognize(buffer, "eng");
    return normalizeExtractedText(result?.data?.text);
  } catch (_error) {
    throw createError(
      422,
      "The image could not be read clearly enough. Try a sharper scan or a PDF export.",
    );
  }
}

function assertUploadPresent(file) {
  if (!file || !file.buffer || !file.originalname) {
    throw createError(400, "Upload a PDF, DOCX, TXT, or image source file first.");
  }
}

function inferSourceKind(file) {
  const extension = getExtension(file.originalname);
  const mimeType = String(file.mimetype || "").toLowerCase();

  if (mimeType.includes("pdf") || extension === ".pdf") {
    return "pdf";
  }

  if (
    mimeType.includes("wordprocessingml.document") ||
    extension === ".docx"
  ) {
    return "docx";
  }

  if (mimeType.startsWith("text/") || extension === ".txt") {
    return "text";
  }

  if (
    mimeType.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(extension)
  ) {
    return "image";
  }

  return "";
}

async function extractTextFromUploadedSource(file) {
  assertUploadPresent(file);
  const sourceKind = inferSourceKind(file);

  if (!sourceKind) {
    throw createError(
      415,
      "Unsupported file type. Upload a PDF, DOCX, TXT, or image scan.",
    );
  }

  let extractedText = "";

  switch (sourceKind) {
    case "pdf":
      extractedText = await extractPdfText(file.buffer);
      break;
    case "docx":
      extractedText = await extractDocxText(file.buffer);
      break;
    case "text":
      extractedText = extractPlainText(file.buffer);
      break;
    case "image":
      extractedText = await extractImageText(file.buffer);
      break;
    default:
      throw createError(
        415,
        "Unsupported file type. Upload a PDF, DOCX, TXT, or image scan.",
      );
  }

  if (extractedText.length < 80) {
    // WHY: AI drafting needs enough real lesson content to plan a useful unit
    // and produce safe teach-first questions rather than guessing from scraps.
    throw createError(
      422,
      "The uploaded file did not produce enough readable text. Try a clearer scan or a text-based export.",
    );
  }

  return {
    fileName: String(file.originalname || "").trim(),
    mimeType: String(file.mimetype || "").trim(),
    sourceKind,
    extractedText,
    extractedCharacterCount: extractedText.length,
  };
}

module.exports = {
  extractTextFromUploadedSource,
};
