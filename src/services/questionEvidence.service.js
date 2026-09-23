/**
 * WHAT:
 * questionEvidence.service validates, stores, extracts, authorizes, and
 * finalizes file evidence attached to one exact mission question.
 * WHY:
 * Original student work must remain auditable while teachers still need a
 * readable semantic preview and learners need safe draft replacement.
 * HOW:
 * Verify the real file signature, store bytes privately in GridFS, persist a
 * question-scoped metadata record, and enforce role/mission ownership on every
 * upload, removal, preview, download, redo, move, and submission boundary.
 */
const crypto = require("crypto");
const path = require("path");
const mongoose = require("mongoose");
const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");
const { PDFParse } = require("pdf-parse");

const Mission = require("../models/Mission");
const MissionWorkDraft = require("../models/MissionWorkDraft");
const QuestionEvidenceFile = require("../models/QuestionEvidenceFile");
const ResultPackage = require("../models/ResultPackage");
const Timetable = require("../models/Timetable");
const User = require("../models/User");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const GRIDFS_BUCKET = "questionEvidence";
const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
]);
const OOXML_FOLDER_BY_EXTENSION = Object.freeze({
  ".docx": "word/",
  ".pptx": "ppt/",
  ".xlsx": "xl/",
});
const MIME_BY_TYPE = Object.freeze({
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});
const LEGACY_OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const XML = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  processEntities: false,
  trimValues: false,
});
const SIMPLE_XML = new XMLParser({
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
});

function createError(statusCode, message, code = "QUESTION_EVIDENCE_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sanitizeFileName(value) {
  return path.basename(String(value || "upload")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
}

function extensionFor(fileName) {
  return path.extname(sanitizeFileName(fileName)).toLowerCase();
}

function startsWith(buffer, signature) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= signature.length &&
    buffer.subarray(0, signature.length).equals(signature);
}

function isZip(buffer) {
  return startsWith(buffer, Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    startsWith(buffer, Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    startsWith(buffer, Buffer.from([0x50, 0x4b, 0x07, 0x08]));
}

async function loadSafeOfficeZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  let expandedBytes = 0;
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error("Office file contains too many entries.");
  }
  for (const entry of entries) {
    const entryBytes = Number(entry?._data?.uncompressedSize || 0);
    expandedBytes += entryBytes;
    if (
      entryBytes > MAX_ZIP_ENTRY_BYTES ||
      expandedBytes > MAX_ZIP_EXPANDED_BYTES
    ) {
      // WHY: A small compressed upload can otherwise expand enough to exhaust
      // the server while validating or previewing an untrusted Office file.
      throw new Error("Office file expands beyond the safe preview limit.");
    }
  }
  return zip;
}

function allowedMimeForType(mimeType, detectedType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (!normalized || normalized === "application/octet-stream") {
    return true;
  }
  return normalized === MIME_BY_TYPE[detectedType];
}

async function detectUploadedType(file) {
  const buffer = file?.buffer;
  const extension = extensionFor(file?.originalname);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createError(400, "Choose a supported evidence file first.", "FILE_REQUIRED");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw createError(413, "Evidence files must be 10 MB or smaller.", "FILE_TOO_LARGE");
  }
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw createError(
      415,
      "Unsupported file type. Upload PDF, Word, PowerPoint, or Excel evidence.",
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  let detectedType = "";
  if (extension === ".pdf" && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    detectedType = "pdf";
  } else if ([".doc", ".ppt", ".xls"].includes(extension) && startsWith(buffer, LEGACY_OLE_SIGNATURE)) {
    detectedType = extension.slice(1);
  } else if (OOXML_FOLDER_BY_EXTENSION[extension] && isZip(buffer)) {
    let zip;
    try {
      zip = await loadSafeOfficeZip(buffer);
    } catch (error) {
      if (/too many entries|safe preview limit/i.test(String(error?.message))) {
        throw createError(
          413,
          "The Office file expands beyond the safe processing limit.",
          "FILE_TOO_LARGE",
        );
      }
      throw createError(415, "The Office file is damaged or has an invalid signature.", "INVALID_FILE_SIGNATURE");
    }
    const requiredFolder = OOXML_FOLDER_BY_EXTENSION[extension];
    const hasRequiredPart = Object.keys(zip.files).some((name) => name.startsWith(requiredFolder));
    if (hasRequiredPart && zip.file("[Content_Types].xml")) {
      detectedType = extension.slice(1);
    }
  }

  if (!detectedType || !allowedMimeForType(file?.mimetype, detectedType)) {
    // WHY: Neither the extension nor browser-provided MIME is trusted alone;
    // the signature/container and declared type must agree before storage.
    throw createError(415, "The file content does not match its Word, PDF, PowerPoint, or Excel type.", "INVALID_FILE_SIGNATURE");
  }
  return detectedType;
}

function safeHttpUrl(value) {
  const raw = String(value || "").trim();
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch (_error) {
    return "";
  }
}

function detectSafeLinks(value) {
  const text = String(value || "");
  const pattern = /(?:https?:\/\/|www\.)[^\s<>{}\[\]"']+/gi;
  const links = [];
  for (const match of text.matchAll(pattern)) {
    const displayText = match[0].replace(/[),.;!?]+$/g, "");
    const url = safeHttpUrl(displayText);
    if (url) {
      links.push({ text: displayText, url, start: match.index, end: Number(match.index) + displayText.length });
    }
  }
  return links;
}

function childArray(node, key) {
  return Array.isArray(node?.[key]) ? node[key] : [];
}

function collectNodes(value, name, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNodes(item, name, result);
    }
    return result;
  }
  if (!value || typeof value !== "object") {
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === name) {
      result.push({ node: value, children: child });
    }
    if (key !== ":@") {
      collectNodes(child, name, result);
    }
  }
  return result;
}

function collectedText(value, textTag) {
  return collectNodes(value, textTag)
    .map(({ children }) => {
      const textNodes = collectNodes(children, "#text");
      return textNodes.map(({ children: text }) => String(text || "")).join("");
    })
    .join("");
}

function nodeHas(value, name) {
  return collectNodes(value, name).length > 0;
}

function firstAttribute(value, elementName, attributeName) {
  const match = collectNodes(value, elementName)[0]?.node;
  return String(match?.[":@"]?.[`@_${attributeName}`] || "");
}

function relationshipMap(xmlText) {
  if (!xmlText) {
    return new Map();
  }
  const parsed = SIMPLE_XML.parse(xmlText);
  const relationships = parsed?.Relationships?.Relationship;
  const entries = Array.isArray(relationships) ? relationships : relationships ? [relationships] : [];
  return new Map(entries.map((item) => [String(item?.["@_Id"] || ""), String(item?.["@_Target"] || "")]));
}

function linkedItems(value, textTag, relationMap) {
  const output = [];
  for (const { node, children } of collectNodes(value, "w:hyperlink")) {
    const id = String(node?.[":@"]?.["@_r:id"] || "");
    const text = collectedText(children, textTag);
    const url = safeHttpUrl(relationMap.get(id));
    if (text && url) {
      output.push({ text, url });
    }
  }
  return output;
}

function paragraphBlock(paragraphNode, relationMap = new Map()) {
  const text = collectedText(paragraphNode, "w:t");
  if (!text.trim()) {
    return null;
  }
  const style = firstAttribute(paragraphNode, "w:pStyle", "w:val");
  const headingMatch = style.match(/heading\s*(\d+)/i);
  const block = headingMatch
    ? { type: "heading", level: Math.min(6, Math.max(1, Number(headingMatch[1]))), text }
    : nodeHas(paragraphNode, "w:numPr")
      ? { type: "list", items: [text] }
      : { type: "paragraph", text };
  const links = linkedItems(paragraphNode, "w:t", relationMap);
  const detected = detectSafeLinks(text);
  if (links.length > 0 || detected.length > 0) {
    block.links = [...links, ...detected];
  }
  return block;
}

function tableBlock(tableNode, paragraphTag, cellTag, rowTag, textTag) {
  const rows = collectNodes(tableNode, rowTag).map(({ children: rowChildren }) =>
    collectNodes(rowChildren, cellTag).map(({ children: cellChildren }) => {
      const paragraphs = collectNodes(cellChildren, paragraphTag)
        .map(({ children }) => collectedText(children, textTag))
        .filter((text) => text.length > 0);
      return paragraphs.join("\n");
    }),
  );
  return { type: "table", rows };
}

async function parseDocx(buffer) {
  const zip = await loadSafeOfficeZip(buffer);
  const documentXml = await zip.file("word/document.xml").async("string");
  const relationsFile = zip.file("word/_rels/document.xml.rels");
  const relationMap = relationshipMap(relationsFile ? await relationsFile.async("string") : "");
  const parsed = XML.parse(documentXml);
  const body = collectNodes(parsed, "w:body")[0]?.children || parsed;
  const blocks = [];
  const bodyItems = Array.isArray(body) ? body : [body];
  for (const item of bodyItems) {
    if (item?.["w:p"]) {
      const block = paragraphBlock(item["w:p"], relationMap);
      if (block) blocks.push(block);
    } else if (item?.["w:tbl"]) {
      blocks.push(tableBlock(item["w:tbl"], "w:p", "w:tc", "w:tr", "w:t"));
    }
  }
  return { parsedType: "blocks", extractedContent: { blocks } };
}

function numericSuffix(value) {
  return Number(String(value || "").match(/(\d+)(?:\.xml)?$/)?.[1] || 0);
}

async function parsePptx(buffer) {
  const zip = await loadSafeOfficeZip(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const slides = [];
  for (const [index, slideName] of slideNames.entries()) {
    const parsed = XML.parse(await zip.file(slideName).async("string"));
    const relationsName = slideName.replace(
      "ppt/slides/",
      "ppt/slides/_rels/",
    ) + ".rels";
    const relationsFile = zip.file(relationsName);
    const relations = relationshipMap(
      relationsFile ? await relationsFile.async("string") : "",
    );
    const blocks = [];
    const shapes = collectNodes(parsed, "p:sp");
    for (const shape of shapes) {
      const paragraphs = collectNodes(shape.children, "a:p");
      for (const paragraph of paragraphs) {
        const text = collectedText(paragraph.children, "a:t");
        if (!text.trim()) continue;
        const block = nodeHas(paragraph.children, "a:buChar") || nodeHas(paragraph.children, "a:buAutoNum")
          ? { type: "list", items: [text] }
          : { type: "paragraph", text };
        const links = detectSafeLinks(text);
        for (const { node } of collectNodes(paragraph.children, "a:hlinkClick")) {
          const relationId = String(node?.[":@"]?.["@_r:id"] || "");
          const url = safeHttpUrl(relations.get(relationId));
          if (url) links.push({ text, url });
        }
        if (links.length > 0) block.links = links;
        blocks.push(block);
      }
    }
    for (const table of collectNodes(parsed, "a:tbl")) {
      blocks.push(tableBlock(table.children, "a:p", "a:tc", "a:tr", "a:t"));
    }
    const firstText = blocks.find((block) => block.type === "paragraph")?.text || `Slide ${index + 1}`;
    if (blocks[0]?.type === "paragraph") {
      blocks[0] = { ...blocks[0], type: "heading", level: 1 };
    }
    const notesName = `ppt/notesSlides/notesSlide${index + 1}.xml`;
    const notesFile = zip.file(notesName);
    const speakerNotes = notesFile
      ? collectedText(XML.parse(await notesFile.async("string")), "a:t")
      : "";
    slides.push({ slideNumber: index + 1, title: firstText, blocks, speakerNotes });
  }
  return { parsedType: "slides", extractedContent: { slides } };
}

function items(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function simpleNodeText(value) {
  if (value === undefined || value === null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(simpleNodeText).join("");
  if (typeof value !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(value, "#text")) {
    return String(value["#text"] || "");
  }
  return Object.entries(value)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => simpleNodeText(child))
    .join("");
}

function excelColumnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return Math.max(0, value - 1);
}

function excelCellValue(cell, sharedStrings, hyperlink = "") {
  const type = String(cell?.["@_t"] || "");
  const formula = simpleNodeText(cell?.f);
  const raw = type === "inlineStr"
    ? simpleNodeText(cell?.is)
    : simpleNodeText(cell?.v);
  let displayedValue = raw;
  if (type === "s") {
    displayedValue = sharedStrings[Number(raw)] || "";
  } else if (type === "b") {
    displayedValue = raw === "1" ? "TRUE" : "FALSE";
  }
  const result = formula
    ? { formula, displayedValue }
    : displayedValue;
  if (!hyperlink) return result;
  return {
    ...(result && typeof result === "object"
      ? result
      : { text: String(result || "") }),
    hyperlink,
  };
}

async function parseXlsx(buffer) {
  const zip = await loadSafeOfficeZip(buffer);
  const workbookFile = zip.file("xl/workbook.xml");
  const workbookRelationsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !workbookRelationsFile) {
    throw new Error("Spreadsheet workbook parts are missing.");
  }
  const workbook = SIMPLE_XML.parse(await workbookFile.async("string"));
  const workbookRelations = relationshipMap(
    await workbookRelationsFile.async("string"),
  );
  const sharedStringsFile = zip.file("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsFile
    ? items(
        SIMPLE_XML.parse(await sharedStringsFile.async("string"))?.sst?.si,
      ).map(simpleNodeText)
    : [];
  const sheetEntries = items(workbook?.workbook?.sheets?.sheet);
  const sheets = [];
  for (const [sheetIndex, sheetEntry] of sheetEntries.entries()) {
    const relationId = String(sheetEntry?.["@_r:id"] || "");
    const target = String(workbookRelations.get(relationId) || "");
    const normalizedTarget = target.startsWith("/")
      ? target.slice(1)
      : path.posix.normalize(path.posix.join("xl", target));
    const sheetFile = zip.file(normalizedTarget);
    if (!sheetFile) continue;
    const worksheet = SIMPLE_XML.parse(await sheetFile.async("string"));
    const relationName = normalizedTarget.replace(
      "xl/worksheets/",
      "xl/worksheets/_rels/",
    ) + ".rels";
    const sheetRelationsFile = zip.file(relationName);
    const sheetRelations = relationshipMap(
      sheetRelationsFile ? await sheetRelationsFile.async("string") : "",
    );
    const hyperlinks = new Map();
    for (const link of items(worksheet?.worksheet?.hyperlinks?.hyperlink)) {
      const url = safeHttpUrl(
        sheetRelations.get(String(link?.["@_r:id"] || "")),
      );
      if (url) hyperlinks.set(String(link?.["@_ref"] || ""), url);
    }
    const rows = items(worksheet?.worksheet?.sheetData?.row).map(
      (row, rowIndex) => {
        const cells = [];
        for (const cell of items(row?.c)) {
          const reference = String(cell?.["@_r"] || "");
          const columnIndex = excelColumnIndex(reference);
          while (cells.length < columnIndex) cells.push("");
          cells[columnIndex] = excelCellValue(
            cell,
            sharedStrings,
            hyperlinks.get(reference) || "",
          );
        }
        return {
          rowNumber: Number(row?.["@_r"] || rowIndex + 1),
          cells,
        };
      },
    );
    sheets.push({
      name: String(sheetEntry?.["@_name"] || `Sheet ${sheetIndex + 1}`),
      rows,
    });
  }
  return { parsedType: "sheets", extractedContent: { sheets } };
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    // WHY: pdf.js transfers document data to its worker. Calling multiple
    // parser operations concurrently can detach the same buffer and fail.
    const textResult = await parser.getText({ parseHyperlinks: true });
    const infoResult = await parser.getInfo({ parsePageInfo: true });
    const tableResult = await parser.getTable();
    const pages = textResult.pages.map((page) => {
      const pageInfo = infoResult.pages.find((item) => Number(item.pageNumber) === Number(page.num));
      const pageTables = tableResult.pages.find((item) => Number(item.num) === Number(page.num));
      const blocks = String(page.text || "")
        .split(/\n{2,}/)
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ type: "paragraph", text, links: detectSafeLinks(text) }));
      for (const rows of pageTables?.tables || []) {
        blocks.push({ type: "table", rows });
      }
      return {
        pageNumber: Number(page.num),
        blocks,
        links: (pageInfo?.links || [])
          .map((link) => ({ text: String(link.text || ""), url: safeHttpUrl(link.url) }))
          .filter((link) => link.url),
      };
    });
    return { parsedType: "pages", extractedContent: { pages } };
  } finally {
    await parser.destroy();
  }
}

async function extractStructuredContent(buffer, detectedType) {
  let parsed;
  switch (detectedType) {
    case "pdf": parsed = await parsePdf(buffer); break;
    case "docx": parsed = await parseDocx(buffer); break;
    case "pptx": parsed = await parsePptx(buffer); break;
    case "xlsx": parsed = await parseXlsx(buffer); break;
    default:
      parsed = {
        parsedType: "unavailable",
        extractedContent: null,
        extractionError: "Preview is unavailable for this legacy Office format. Download the original file to review it.",
      };
  }
  if (
    parsed.extractedContent &&
    Buffer.byteLength(JSON.stringify(parsed.extractedContent), "utf8") >
      MAX_PREVIEW_BYTES
  ) {
    throw new Error("Extracted preview exceeds the safe stored-preview limit.");
  }
  return parsed;
}

async function extractStructuredContentSafely(buffer, detectedType, context = {}) {
  try {
    return await extractStructuredContent(buffer, detectedType);
  } catch (error) {
    // WHY: Extraction is a convenience layer; a parser failure must never
    // discard valid original evidence that has already passed validation.
    console.warn("[question-evidence] extraction_unavailable", {
      ...context,
      detectedType,
      message: String(error?.message || error),
    });
    return {
      parsedType: "unavailable",
      extractedContent: null,
      extractionError: "File saved. We could not generate a text preview.",
    };
  }
}

function bucket() {
  if (!mongoose.connection?.db) {
    throw createError(503, "Evidence storage is not connected.", "STORAGE_UNAVAILABLE");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: GRIDFS_BUCKET });
}

async function storeOriginalFile({ buffer, fileName, mimeType, metadata }) {
  return new Promise((resolve, reject) => {
    const stream = bucket().openUploadStream(fileName, { contentType: mimeType, metadata });
    stream.once("error", reject);
    stream.once("finish", () => resolve(stream.id));
    stream.end(buffer);
  });
}

async function deleteStoredFile(storageFileId) {
  try {
    await bucket().delete(storageFileId);
  } catch (error) {
    if (String(error?.code || "") !== "ENOENT") {
      throw error;
    }
  }
}

function serializeQuestionEvidence(record) {
  const source = record?.toObject ? record.toObject() : record || {};
  return {
    id: String(source._id || source.id || ""),
    originalFileName: String(source.originalFileName || ""),
    mimeType: String(source.mimeType || ""),
    detectedType: String(source.detectedType || ""),
    fileSize: Number(source.fileSize || 0),
    fileHash: String(source.fileHash || ""),
    parsedType: String(source.parsedType || "unavailable"),
    extractedContent: source.extractedContent || null,
    previewStatus: String(source.previewStatus || "unavailable"),
    extractionError: String(source.extractionError || ""),
    uploadedBy: String(source.uploadedBy || ""),
    uploadedByRole: String(source.uploadedByRole || ""),
    uploadedAt: source.uploadedAt ? new Date(source.uploadedAt).toISOString() : null,
    missionId: String(source.missionId || ""),
    questionId: String(source.questionId || ""),
    questionIndex: Number(source.questionIndex || 0),
    resultPackageId: String(source.resultPackageId || ""),
    status: String(source.status || "draft"),
    previousSubmittedEvidenceIds: (source.previousSubmittedEvidenceIds || []).map(String),
  };
}

async function loadMissionQuestion({ missionId, questionIndex }) {
  const mission = await Mission.findById(missionId).lean();
  const index = Number(questionIndex);
  if (!mission || !Number.isInteger(index) || index < 0 || index >= (mission.questions || []).length) {
    throw createError(404, "Mission question not found.", "QUESTION_NOT_FOUND");
  }
  return { mission, question: mission.questions[index], questionIndex: index };
}

async function assertTeacherAuthority({ teacherId, mission }) {
  if (String(mission.createdBy || "") === String(teacherId || "")) {
    return;
  }
  const teacher = await User.findOne({ _id: teacherId, role: "teacher" }).select("assignedStudents").lean();
  const assigned = (teacher?.assignedStudents || []).some(
    (studentId) => String(studentId) === String(mission.studentId),
  );
  if (!assigned) {
    throw createError(403, "Teachers can only manage evidence for assigned students.", "EVIDENCE_ACCESS_DENIED");
  }
  const ownsLesson = await Timetable.exists({
    studentId: mission.studentId,
    $or: [
      { morningSubject: mission.subjectId, morningTeacherId: teacherId },
      { afternoonSubject: mission.subjectId, afternoonTeacherId: teacherId },
    ],
  });
  if (!ownsLesson) {
    throw createError(403, "Teachers can only manage evidence for their assigned subject.", "EVIDENCE_ACCESS_DENIED");
  }
}

async function authorizeContext({ actorId, actorRole, missionId, questionIndex, requireEditable = false }) {
  const context = await loadMissionQuestion({ missionId, questionIndex });
  const { mission, question } = context;
  if (actorRole === "student") {
    if (String(mission.studentId || "") !== String(actorId || "")) {
      throw createError(403, "Students can only upload evidence to their own mission.", "EVIDENCE_ACCESS_DENIED");
    }
    if (question.allowStudentUpload !== true) {
      throw createError(403, "Student file upload is not enabled for this question.", "STUDENT_UPLOAD_DISABLED");
    }
  } else if (actorRole === "teacher") {
    await assertTeacherAuthority({ teacherId: actorId, mission });
  } else {
    throw createError(403, "This role cannot manage question evidence.", "EVIDENCE_ACCESS_DENIED");
  }
  if (requireEditable && mission.latestResultPackageId) {
    throw createError(409, "Submitted evidence cannot be replaced directly. Create a redo instead.", "EVIDENCE_SUBMITTED");
  }
  return context;
}

async function uploadQuestionEvidence({ actorId, actorRole, missionId, questionIndex, file }) {
  console.info("[question-evidence] upload_start", { actorId, actorRole, missionId, questionIndex });
  const { mission, question } = await authorizeContext({
    actorId, actorRole, missionId, questionIndex, requireEditable: actorRole === "student",
  });
  const detectedType = await detectUploadedType(file);
  const questionId = String(
    question?.id || `question-${Number(questionIndex) + 1}`,
  );
  const originalFileName = sanitizeFileName(file.originalname);
  const mimeType = MIME_BY_TYPE[detectedType];
  const fileHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const existingDraft = await QuestionEvidenceFile.findOne({
    missionId: mission._id,
    questionId,
    status: "draft",
  });
  const existingSubmitted = mission.latestResultPackageId
    ? await QuestionEvidenceFile.findOne({
        missionId: mission._id,
        questionId,
        status: "submitted",
      }).lean()
    : null;
  if (existingSubmitted) {
    throw createError(
      409,
      "Submitted evidence is immutable. Create a redo to provide replacement evidence.",
      "EVIDENCE_SUBMITTED",
    );
  }
  if (actorRole === "student" && existingDraft?.uploadedByRole === "teacher") {
    throw createError(
      403,
      "Students cannot replace teacher-added evidence.",
      "EVIDENCE_ACCESS_DENIED",
    );
  }
  if (mission.latestResultPackageId && existingDraft) {
    throw createError(409, "Submitted evidence cannot be replaced directly. Create a redo instead.", "EVIDENCE_SUBMITTED");
  }
  const workDraft = await MissionWorkDraft.findOne({ studentId: mission.studentId, missionId: mission._id }).select("_id").lean();
  const storageFileId = await storeOriginalFile({
    buffer: file.buffer,
    fileName: originalFileName,
    mimeType,
    metadata: {
      missionId: String(mission._id),
      questionIndex: Number(questionIndex),
      uploadedBy: String(actorId),
      fileHash,
    },
  });

  const parsed = await extractStructuredContentSafely(
    file.buffer,
    detectedType,
    {
      missionId: String(mission._id),
      questionIndex: Number(questionIndex),
    },
  );

  let record;
  try {
    record = await QuestionEvidenceFile.create({
      originalFileName,
      mimeType,
      detectedType,
      fileSize: file.buffer.length,
      fileHash,
      storageFileId,
      storageBucket: GRIDFS_BUCKET,
      parsedType: parsed.parsedType,
      extractedContent: parsed.extractedContent,
      previewStatus: parsed.extractedContent ? "available" : "unavailable",
      extractionError: parsed.extractionError || "",
      uploadedBy: actorId,
      uploadedByRole: actorRole,
      uploadedAt: new Date(),
      studentId: mission.studentId,
      subjectId: mission.subjectId,
      missionId: mission._id,
      questionId,
      questionIndex: Number(questionIndex),
      workDraftId: workDraft?._id || null,
      resultPackageId: mission.latestResultPackageId || null,
      status: mission.latestResultPackageId ? "submitted" : "draft",
    });
  } catch (error) {
    await deleteStoredFile(storageFileId);
    throw error;
  }

  if (existingDraft) {
    await QuestionEvidenceFile.updateOne(
      { _id: existingDraft._id, status: "draft" },
      { $set: { status: "superseded", supersededAt: new Date() } },
    );
    await deleteStoredFile(existingDraft.storageFileId);
  }
  console.info("[question-evidence] upload_complete", {
    evidenceId: String(record._id), missionId, questionIndex, detectedType,
  });
  return serializeQuestionEvidence(record);
}

async function listMissionQuestionEvidence({ actorId, actorRole, missionId }) {
  const mission = await Mission.findById(missionId).lean();
  if (!mission) throw createError(404, "Mission not found.", "MISSION_NOT_FOUND");
  if (actorRole === "student" && String(mission.studentId) !== String(actorId)) {
    throw createError(403, "Students can only view their own evidence.", "EVIDENCE_ACCESS_DENIED");
  }
  if (actorRole === "teacher") {
    await assertTeacherAuthority({ teacherId: actorId, mission });
  } else if (actorRole !== "student") {
    throw createError(403, "This role cannot view question evidence.", "EVIDENCE_ACCESS_DENIED");
  }
  const records = await QuestionEvidenceFile.find({
    missionId,
    status: { $in: mission.latestResultPackageId ? ["submitted"] : ["draft"] },
  }).sort({ questionIndex: 1, createdAt: -1 }).lean();
  let previousRecords = mission.redoOfResultPackageId
    ? await QuestionEvidenceFile.find({
        resultPackageId: mission.redoOfResultPackageId,
        status: "submitted",
      }).sort({ questionIndex: 1, createdAt: 1 }).lean()
    : [];
  if (mission.redoOfResultPackageId && previousRecords.length === 0) {
    // WHY: Move keeps the original immutable file ids inside the target
    // ResultPackage snapshot. A later redo must resolve those ids as prior
    // provenance even though GridFS metadata still belongs to the source.
    const previousPackage = await ResultPackage.findById(
      mission.redoOfResultPackageId,
    ).select("evidence.questionEvidenceFiles").lean();
    const previousIds = (
      previousPackage?.evidence?.questionEvidenceFiles || []
    ).map((item) => item?.id).filter(Boolean);
    if (previousIds.length > 0) {
      previousRecords = await QuestionEvidenceFile.find({
        _id: { $in: previousIds },
        status: "submitted",
      }).sort({ questionIndex: 1, createdAt: 1 }).lean();
    }
  }
  return [
    ...previousRecords.map((record) => ({
      ...serializeQuestionEvidence(record),
      isPreviousSubmittedEvidence: true,
    })),
    ...records.map((record) => ({
      ...serializeQuestionEvidence(record),
      isPreviousSubmittedEvidence: false,
    })),
  ];
}

async function removeDraftQuestionEvidence({ actorId, actorRole, missionId, questionIndex }) {
  const { question } = await authorizeContext({
    actorId,
    actorRole,
    missionId,
    questionIndex,
    requireEditable: true,
  });
  const questionId = String(
    question?.id || `question-${Number(questionIndex) + 1}`,
  );
  const record = await QuestionEvidenceFile.findOne({
    missionId,
    questionId,
    status: "draft",
  });
  if (!record) throw createError(404, "Draft evidence file not found.", "EVIDENCE_NOT_FOUND");
  if (actorRole === "student" && record.uploadedByRole !== "student") {
    throw createError(403, "Students cannot remove teacher-added evidence.", "EVIDENCE_ACCESS_DENIED");
  }
  record.status = "superseded";
  record.supersededAt = new Date();
  await record.save();
  await deleteStoredFile(record.storageFileId);
  return { removed: true, evidenceId: String(record._id) };
}

async function loadAuthorizedEvidence({ actorId, actorRole, evidenceId }) {
  const record = await QuestionEvidenceFile.findById(evidenceId).lean();
  if (!record || record.status === "superseded") {
    throw createError(404, "Evidence file not found.", "EVIDENCE_NOT_FOUND");
  }
  if (actorRole === "student" && String(record.studentId) !== String(actorId)) {
    throw createError(403, "Students can only open their own evidence.", "EVIDENCE_ACCESS_DENIED");
  }
  if (actorRole === "teacher") {
    const mission = await Mission.findById(record.missionId).lean();
    if (!mission) throw createError(404, "Mission not found.", "MISSION_NOT_FOUND");
    await assertTeacherAuthority({ teacherId: actorId, mission });
  } else if (actorRole !== "student") {
    throw createError(403, "This role cannot open question evidence.", "EVIDENCE_ACCESS_DENIED");
  }
  return record;
}

async function openEvidenceDownload({ actorId, actorRole, evidenceId }) {
  const record = await loadAuthorizedEvidence({ actorId, actorRole, evidenceId });
  return {
    record: serializeQuestionEvidence(record),
    stream: bucket().openDownloadStream(record.storageFileId),
  };
}

async function finalizeMissionEvidence({ studentId, missionId, resultPackageId }) {
  const [records, mission] = await Promise.all([
    QuestionEvidenceFile.find({
      studentId, missionId, status: "draft",
    }).sort({ questionIndex: 1, createdAt: 1 }),
    Mission.findById(missionId).select("questions.id").lean(),
  ]);
  if (records.length === 0) return [];
  const questionIndexById = new Map(
    (mission?.questions || []).map((question, index) => [
      String(question?.id || `question-${index + 1}`),
      index,
    ]),
  );
  for (const record of records) {
    record.status = "submitted";
    record.resultPackageId = resultPackageId;
    if (questionIndexById.has(String(record.questionId || ""))) {
      record.questionIndex = questionIndexById.get(String(record.questionId));
    }
    await record.save();
  }
  return records.map(serializeQuestionEvidence);
}

async function draftQuestionEvidenceForMission({ studentId, missionId }) {
  const [records, mission] = await Promise.all([
    QuestionEvidenceFile.find({
      studentId,
      missionId,
      status: "draft",
    }).sort({ questionIndex: 1, createdAt: 1 }).lean(),
    Mission.findById(missionId).select("questions.id").lean(),
  ]);
  const questionIndexById = new Map(
    (mission?.questions || []).map((question, index) => [
      String(question?.id || `question-${index + 1}`),
      index,
    ]),
  );
  return records.map((record) => serializeQuestionEvidence({
    ...record,
    questionIndex: questionIndexById.has(String(record.questionId || ""))
      ? questionIndexById.get(String(record.questionId))
      : record.questionIndex,
  }));
}

async function copyRedoProvenance({ sourceMissionId, redoMissionId }) {
  const previous = await QuestionEvidenceFile.find({
    missionId: sourceMissionId,
    status: "submitted",
  }).select("_id questionIndex").lean();
  if (previous.length === 0) return [];
  return previous.map((item) => ({
    questionIndex: Number(item.questionIndex),
    previousSubmittedEvidenceIds: [item._id],
  }));
}

async function questionEvidenceForResultPackage(resultPackageId) {
  const records = await QuestionEvidenceFile.find({
    resultPackageId,
    status: "submitted",
  }).sort({ questionIndex: 1, createdAt: 1 }).lean();
  return records.map(serializeQuestionEvidence);
}

module.exports = {
  MAX_FILE_BYTES,
  authorizeContext,
  copyRedoProvenance,
  detectSafeLinks,
  detectUploadedType,
  draftQuestionEvidenceForMission,
  extractStructuredContent,
  extractStructuredContentSafely,
  finalizeMissionEvidence,
  listMissionQuestionEvidence,
  loadAuthorizedEvidence,
  openEvidenceDownload,
  questionEvidenceForResultPackage,
  removeDraftQuestionEvidence,
  safeHttpUrl,
  serializeQuestionEvidence,
  uploadQuestionEvidence,
};
