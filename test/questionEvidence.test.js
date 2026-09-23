/**
 * WHAT:
 * Tests question evidence file validation, semantic extraction, safe links,
 * parser fallback, and the student/teacher permission boundary.
 * WHY:
 * Qualification evidence must reject disguised files, remain readable after
 * extraction, and never let a disabled student upload to a question.
 * HOW:
 * Build small real Office/PDF buffers in memory and stub only the mission read
 * needed by the deterministic authorization helper.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const JSZip = require("jszip");
const PDFDocument = require("pdfkit");
const { Writable } = require("node:stream");
const mongoose = require("mongoose");

const Mission = require("../src/models/Mission");
const MissionWorkDraft = require("../src/models/MissionWorkDraft");
const QuestionEvidenceFile = require("../src/models/QuestionEvidenceFile");
const Timetable = require("../src/models/Timetable");
const User = require("../src/models/User");
const questionEvidence = require("../src/services/questionEvidence.service");
const resultService = require("../src/services/result.service");
const { errorHandler } = require("../src/middleware/error.middleware");

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function docxBuffer({ malformed = false } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  if (malformed) {
    zip.file("word/placeholder.xml", "not a document");
  } else {
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="w" xmlns:r="r"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project evidence</w:t></w:r></w:p>
          <w:p><w:r><w:t>Read https://example.com/source</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>
        </w:body></w:document>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

async function pptxBuffer() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file(
    "ppt/slides/slide2.xml",
    '<p:sld xmlns:p="p" xmlns:a="a"><p:sp><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sp></p:sld>',
  );
  zip.file(
    "ppt/slides/slide1.xml",
    '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:sp><a:p><a:r><a:t>First slide</a:t></a:r></a:p><a:p><a:buChar char="•"/><a:r><a:rPr><a:hlinkClick r:id="rId1"/></a:rPr><a:t>One point</a:t></a:r></a:p></p:sp></p:sld>',
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    '<Relationships><Relationship Id="rId1" Target="https://example.com/slides"/></Relationships>',
  );
  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    '<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Teacher note</a:t></a:r></a:p></p:notes>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function xlsxBuffer() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="r"><sheets><sheet name="Costs" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    "xl/sharedStrings.xml",
    '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Source</t></si></sst>',
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet xmlns:r="r"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row><row r="3"><c r="B3"><f>SUM(B2:B2)</f><v>12</v></c></row></sheetData><hyperlinks><hyperlink ref="A2" r:id="rId2"/></hyperlinks></worksheet>',
  );
  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    '<Relationships><Relationship Id="rId2" Target="https://example.com/data"/></Relationships>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function pdfBuffer() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ autoFirstPage: true });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.text("Evidence page one https://example.com/pdf");
    doc.addPage();
    doc.text("Evidence page two");
    doc.end();
  });
}

function queryReturning(value) {
  const query = {
    lean: async () => value,
    select: () => query,
    sort: () => query,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
}

async function withUploadStubs(
  { mission, existingDraft = null, existingSubmitted = null },
  callback,
) {
  const originals = {
    missionFindById: Mission.findById,
    workDraftFindOne: MissionWorkDraft.findOne,
    evidenceFindOne: QuestionEvidenceFile.findOne,
    evidenceCreate: QuestionEvidenceFile.create,
    evidenceUpdateOne: QuestionEvidenceFile.updateOne,
    gridDescriptor: Object.getOwnPropertyDescriptor(
      mongoose.mongo,
      "GridFSBucket",
    ),
    connectionDb: mongoose.connection.db,
  };
  const stored = [];
  const deleted = [];
  const created = [];
  const updated = [];
  class FakeGridFSBucket {
    openUploadStream(fileName, options) {
      const chunks = [];
      const stream = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
      stream.id = new mongoose.Types.ObjectId();
      stream.once("finish", () => {
        stored.push({
          id: stream.id,
          fileName,
          options,
          bytes: Buffer.concat(chunks),
        });
      });
      return stream;
    }

    async delete(id) {
      deleted.push(String(id));
    }
  }
  Object.defineProperty(mongoose.mongo, "GridFSBucket", {
    configurable: true,
    value: FakeGridFSBucket,
  });
  mongoose.connection.db = {};
  Mission.findById = () => queryReturning(mission);
  MissionWorkDraft.findOne = () => queryReturning(null);
  let evidenceFindCount = 0;
  QuestionEvidenceFile.findOne = () => {
    evidenceFindCount += 1;
    return queryReturning(
      evidenceFindCount === 1 ? existingDraft : existingSubmitted,
    );
  };
  QuestionEvidenceFile.create = async (payload) => {
    created.push(payload);
    return { _id: new mongoose.Types.ObjectId(), ...payload };
  };
  QuestionEvidenceFile.updateOne = async (...args) => {
    updated.push(args);
    return { modifiedCount: 1 };
  };
  try {
    await callback({ stored, deleted, created, updated });
  } finally {
    Mission.findById = originals.missionFindById;
    MissionWorkDraft.findOne = originals.workDraftFindOne;
    QuestionEvidenceFile.findOne = originals.evidenceFindOne;
    QuestionEvidenceFile.create = originals.evidenceCreate;
    QuestionEvidenceFile.updateOne = originals.evidenceUpdateOne;
    Object.defineProperty(
      mongoose.mongo,
      "GridFSBucket",
      originals.gridDescriptor,
    );
    mongoose.connection.db = originals.connectionDb;
  }
}

test("rejects disguised and oversized evidence files", async () => {
  await assert.rejects(
    questionEvidence.detectUploadedType({
      originalname: "fake.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("not a pdf"),
    }),
    (error) => error.code === "INVALID_FILE_SIGNATURE" && error.statusCode === 415,
  );
  await assert.rejects(
    questionEvidence.detectUploadedType({
      originalname: "large.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.alloc(questionEvidence.MAX_FILE_BYTES + 1),
    }),
    (error) => error.code === "FILE_TOO_LARGE" && error.statusCode === 413,
  );
});

test("multipart size rejection returns a clear 413 response", () => {
  let responseStatus = 0;
  let responseBody;
  errorHandler(
    { name: "MulterError", code: "LIMIT_FILE_SIZE", message: "too large" },
    {},
    {
      status(value) {
        responseStatus = value;
        return this;
      },
      json(value) {
        responseBody = value;
      },
    },
    () => {},
  );
  assert.equal(responseStatus, 413);
  assert.match(responseBody.message, /10 MB/);
});

test("validates and extracts Word blocks, table, list, and safe link", async () => {
  const buffer = await docxBuffer();
  assert.equal(await questionEvidence.detectUploadedType({
    originalname: "evidence.docx", mimetype: MIME.docx, buffer,
  }), "docx");
  const parsed = await questionEvidence.extractStructuredContent(buffer, "docx");
  assert.equal(parsed.parsedType, "blocks");
  assert.deepEqual(parsed.extractedContent.blocks.map((block) => block.type), [
    "heading", "paragraph", "table", "list",
  ]);
  assert.equal(parsed.extractedContent.blocks[2].rows[0][1], "42");
  assert.equal(parsed.extractedContent.blocks[1].links[0].url, "https://example.com/source");
});

test("extracts PowerPoint slides in numeric order with notes and list structure", async () => {
  const buffer = await pptxBuffer();
  assert.equal(await questionEvidence.detectUploadedType({
    originalname: "slides.pptx", mimetype: MIME.pptx, buffer,
  }), "pptx");
  const parsed = await questionEvidence.extractStructuredContent(buffer, "pptx");
  assert.equal(parsed.parsedType, "slides");
  assert.equal(parsed.extractedContent.slides[0].title, "First slide");
  assert.equal(parsed.extractedContent.slides[0].blocks[1].type, "list");
  assert.equal(
    parsed.extractedContent.slides[0].blocks[1].links[0].url,
    "https://example.com/slides",
  );
  assert.equal(parsed.extractedContent.slides[0].speakerNotes, "Teacher note");
  assert.equal(parsed.extractedContent.slides[1].title, "Second slide");
});

test("extracts Excel sheet rows, displayed formula result, and safe hyperlink", async () => {
  const buffer = await xlsxBuffer();
  assert.equal(await questionEvidence.detectUploadedType({
    originalname: "costs.xlsx", mimetype: MIME.xlsx, buffer,
  }), "xlsx");
  const parsed = await questionEvidence.extractStructuredContent(buffer, "xlsx");
  const rows = parsed.extractedContent.sheets[0].rows;
  assert.equal(parsed.extractedContent.sheets[0].name, "Costs");
  assert.deepEqual(rows[1].cells[0], {
    text: "Source",
    hyperlink: "https://example.com/data",
  });
  assert.deepEqual(rows[2].cells[1], {
    formula: "SUM(B2:B2)",
    displayedValue: "12",
  });
});

test("extracts PDF pages and keeps ordinary web links safe", async () => {
  const buffer = await pdfBuffer();
  assert.equal(await questionEvidence.detectUploadedType({
    originalname: "work.pdf", mimetype: "application/pdf", buffer,
  }), "pdf");
  const parsed = await questionEvidence.extractStructuredContent(buffer, "pdf");
  assert.equal(parsed.parsedType, "pages");
  assert.equal(parsed.extractedContent.pages.length, 2);
  assert.match(parsed.extractedContent.pages[0].blocks[0].text, /Evidence page one/);
});

test("parser failure returns an unavailable preview without invalidating the file", async () => {
  const buffer = await docxBuffer({ malformed: true });
  assert.equal(await questionEvidence.detectUploadedType({
    originalname: "retained.docx", mimetype: MIME.docx, buffer,
  }), "docx");
  const parsed = await questionEvidence.extractStructuredContentSafely(buffer, "docx");
  assert.equal(parsed.parsedType, "unavailable");
  assert.equal(parsed.extractedContent, null);
  assert.match(parsed.extractionError, /File saved/);
});

test("safe link detection allows only http, https, and www targets", () => {
  const links = questionEvidence.detectSafeLinks(
    "See www.example.com and https://school.example/path. javascript:alert(1) file:///tmp/a",
  );
  assert.equal(links.length, 2);
  assert.equal(links[0].url, "https://www.example.com/");
  assert.equal(links[1].url, "https://school.example/path");
  assert.equal(questionEvidence.safeHttpUrl("data:text/html,hello"), "");
});

test("read-only report HTML links safe web URLs and escapes authored markup", () => {
  const html = resultService.escapeHtmlWithSafeLinks(
    '<img src=x onerror=alert(1)> https://school.example/work javascript:alert(2)',
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/school\.example\/work"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("full result PDF includes question evidence metadata and structured text", async () => {
  const pdf = await resultService.buildResultReportPdfBuffer({
    resultPackage: {
      missionType: "THEORY",
      meta: {
        studentName: "Student One",
        missionTitle: "Theory mission",
        taskCodes: ["P1"],
        score: { correct: 70, total: 100, percent: 70 },
      },
      evidence: {
        format: "THEORY",
        questions: [{
          questionText: "Explain the evidence.",
          studentAnswer: "My answer.",
          meetsMinimumWords: true,
        }],
        questionEvidenceFiles: [{
          questionIndex: 0,
          originalFileName: "question-work.docx",
          detectedType: "docx",
          uploadedAt: "2026-09-23T10:00:00.000Z",
          fileHash: "b".repeat(64),
          extractedContent: {
            blocks: [{ type: "paragraph", text: "Structured report evidence." }],
          },
        }],
      },
    },
  });
  const parsed = await questionEvidence.extractStructuredContent(pdf, "pdf");
  const text = JSON.stringify(parsed.extractedContent);
  assert.match(text, /question-work\.docx/);
  assert.match(text, /Structured report evidence\./);
});

test("student permission defaults off while teacher ownership remains allowed", async () => {
  const originalFindById = Mission.findById;
  let allowStudentUpload = false;
  Mission.findById = () => ({
    lean: async () => ({
      _id: "mission-1",
      studentId: "student-1",
      createdBy: "teacher-1",
      questions: [{ prompt: "Evidence?", allowStudentUpload }],
    }),
  });
  try {
    await assert.rejects(
      questionEvidence.authorizeContext({
        actorId: "student-1",
        actorRole: "student",
        missionId: "mission-1",
        questionIndex: 0,
      }),
      (error) => error.code === "STUDENT_UPLOAD_DISABLED" && error.statusCode === 403,
    );
    allowStudentUpload = true;
    const studentContext = await questionEvidence.authorizeContext({
      actorId: "student-1",
      actorRole: "student",
      missionId: "mission-1",
      questionIndex: 0,
    });
    assert.equal(studentContext.question.allowStudentUpload, true);
    const teacherContext = await questionEvidence.authorizeContext({
      actorId: "teacher-1",
      actorRole: "teacher",
      missionId: "mission-1",
      questionIndex: 0,
    });
    assert.equal(teacherContext.questionIndex, 0);
  } finally {
    Mission.findById = originalFindById;
  }
});

test("teacher upload preserves original bytes and exact question association", async () => {
  const buffer = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from("legacy word evidence"),
  ]);
  await withUploadStubs(
    {
      mission: {
        _id: "mission-1",
        studentId: "student-1",
        subjectId: "subject-1",
        createdBy: "teacher-1",
        latestResultPackageId: null,
        questions: [{ prompt: "Upload work", allowStudentUpload: false }],
      },
    },
    async ({ stored, created }) => {
      const response = await questionEvidence.uploadQuestionEvidence({
        actorId: "teacher-1",
        actorRole: "teacher",
        missionId: "mission-1",
        questionIndex: 0,
        file: {
          originalname: "Original Work.doc",
          mimetype: "application/msword",
          buffer,
        },
      });
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0].bytes, buffer);
      assert.equal(created[0].missionId, "mission-1");
      assert.equal(created[0].questionIndex, 0);
      assert.equal(created[0].questionId, "question-1");
      assert.equal(created[0].originalFileName, "Original Work.doc");
      assert.equal(created[0].status, "draft");
      assert.equal(response.previewStatus, "unavailable");
      assert.equal(response.fileHash.length, 64);
    },
  );
});

test("draft replacement supersedes metadata and removes only old stored bytes", async () => {
  const oldStorageId = new mongoose.Types.ObjectId();
  await withUploadStubs(
    {
      mission: {
        _id: "mission-1",
        studentId: "student-1",
        subjectId: "subject-1",
        createdBy: "teacher-1",
        latestResultPackageId: null,
        questions: [{ prompt: "Upload work", allowStudentUpload: false }],
      },
      existingDraft: {
        _id: "old-evidence",
        uploadedByRole: "student",
        storageFileId: oldStorageId,
      },
    },
    async ({ deleted, updated }) => {
      await questionEvidence.uploadQuestionEvidence({
        actorId: "teacher-1",
        actorRole: "teacher",
        missionId: "mission-1",
        questionIndex: 0,
        file: {
          originalname: "replacement.pdf",
          mimetype: "application/pdf",
          buffer: await pdfBuffer(),
        },
      });
      assert.equal(updated.length, 1);
      assert.equal(updated[0][0]._id, "old-evidence");
      assert.equal(updated[0][1].$set.status, "superseded");
      assert.deepEqual(deleted, [String(oldStorageId)]);
    },
  );
});

test("student cannot access another learner mission even when upload is enabled", async () => {
  const originalFindById = Mission.findById;
  Mission.findById = () => queryReturning({
    _id: "mission-1",
    studentId: "student-owner",
    questions: [{ allowStudentUpload: true }],
  });
  try {
    await assert.rejects(
      questionEvidence.authorizeContext({
        actorId: "student-other",
        actorRole: "student",
        missionId: "mission-1",
        questionIndex: 0,
      }),
      (error) => error.code === "EVIDENCE_ACCESS_DENIED",
    );
  } finally {
    Mission.findById = originalFindById;
  }
});

test("teacher authorization rejects an unassigned mission and subject", async () => {
  const originals = {
    missionFindById: Mission.findById,
    userFindOne: User.findOne,
    timetableExists: Timetable.exists,
  };
  Mission.findById = () => queryReturning({
    _id: "mission-1",
    createdBy: "teacher-owner",
    studentId: "student-1",
    subjectId: "subject-1",
    questions: [{ allowStudentUpload: false }],
  });
  User.findOne = () => queryReturning({ assignedStudents: [] });
  Timetable.exists = async () => false;
  try {
    await assert.rejects(
      questionEvidence.authorizeContext({
        actorId: "teacher-other",
        actorRole: "teacher",
        missionId: "mission-1",
        questionIndex: 0,
      }),
      (error) => error.code === "EVIDENCE_ACCESS_DENIED" && error.statusCode === 403,
    );
  } finally {
    Mission.findById = originals.missionFindById;
    User.findOne = originals.userFindOne;
    Timetable.exists = originals.timetableExists;
  }
});

test("submitted question evidence cannot be replaced or duplicated", async () => {
  await withUploadStubs(
    {
      mission: {
        _id: "mission-1",
        studentId: "student-1",
        subjectId: "subject-1",
        createdBy: "teacher-1",
        latestResultPackageId: "result-1",
        questions: [{ prompt: "Upload work", allowStudentUpload: true }],
      },
      existingSubmitted: { _id: "submitted-evidence" },
    },
    async ({ stored, created }) => {
      await assert.rejects(
        questionEvidence.uploadQuestionEvidence({
          actorId: "teacher-1",
          actorRole: "teacher",
          missionId: "mission-1",
          questionIndex: 0,
          file: {
            originalname: "replacement.pdf",
            mimetype: "application/pdf",
            buffer: await pdfBuffer(),
          },
        }),
        (error) => error.code === "EVIDENCE_SUBMITTED" && error.statusCode === 409,
      );
      assert.equal(stored.length, 0);
      assert.equal(created.length, 0);
    },
  );
});

test("submission finalization keeps file identity and links the result package", async () => {
  const originalFind = QuestionEvidenceFile.find;
  const originalMissionFindById = Mission.findById;
  const records = [
    {
      _id: new mongoose.Types.ObjectId(),
      status: "draft",
      resultPackageId: null,
      questionId: "question-1",
      questionIndex: 0,
      originalFileName: "work.docx",
      previousSubmittedEvidenceIds: [],
      async save() {},
    },
  ];
  QuestionEvidenceFile.find = () => queryReturning(records);
  Mission.findById = () => queryReturning({
    questions: [{ id: "question-2" }, { id: "question-1" }],
  });
  try {
    const beforeId = String(records[0]._id);
    const finalized = await questionEvidence.finalizeMissionEvidence({
      studentId: "student-1",
      missionId: "mission-1",
      resultPackageId: "result-1",
    });
    assert.equal(String(records[0]._id), beforeId);
    assert.equal(records[0].status, "submitted");
    assert.equal(records[0].resultPackageId, "result-1");
    assert.equal(records[0].questionIndex, 1);
    assert.equal(finalized[0].id, beforeId);
  } finally {
    QuestionEvidenceFile.find = originalFind;
    Mission.findById = originalMissionFindById;
  }
});
