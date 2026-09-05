/**
 * WHAT:
 * Tests the backend contract for optional per-question YouTube learning videos.
 * WHY:
 * Persistence accepts only recognized YouTube IDs, while old mission documents
 * must continue serializing with safe empty-video defaults.
 * HOW:
 * Exercise supported and rejected URL shapes, placement normalization, and the
 * public mission serializer with both legacy and video-enabled questions.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { serializeMission } = require("../src/utils/missionSerializer");
const {
  DEFAULT_LEARNING_VIDEO_PLACEMENT,
  normalizeLearningVideoPlacement,
  parseYouTubeVideoUrl,
} = require("../src/utils/youtubeVideo");

const VIDEO_ID = "dQw4w9WgXcQ";

test("common YouTube URLs normalize to one canonical watch URL", () => {
  const urls = [
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?t=30`,
    `youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://m.youtube.com/live/${VIDEO_ID}`,
  ];

  for (const url of urls) {
    assert.deepEqual(parseYouTubeVideoUrl(url), {
      videoId: VIDEO_ID,
      canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
    });
  }
});

test("unsafe or unsupported video values are rejected", () => {
  assert.equal(parseYouTubeVideoUrl(`https://example.com/watch?v=${VIDEO_ID}`), null);
  assert.equal(parseYouTubeVideoUrl('<iframe src="youtube.com"></iframe>'), null);
  assert.equal(parseYouTubeVideoUrl("https://youtu.be/too-short"), null);
});

test("placement values use a backward-compatible default", () => {
  assert.equal(
    normalizeLearningVideoPlacement(undefined),
    DEFAULT_LEARNING_VIDEO_PLACEMENT,
  );
  assert.equal(normalizeLearningVideoPlacement("afterExplanation"), "afterExplanation");
  assert.equal(normalizeLearningVideoPlacement("unsupported"), null);
});

test("mission serialization preserves valid video fields and defaults legacy questions", () => {
  const payload = serializeMission({
    _id: "mission-1",
    title: "Business Online",
    draftFormat: "QUESTIONS",
    questions: [
      {
        _id: "question-1",
        learningText: "Learn this first.",
        prompt: "What is ecommerce?",
        options: ["Online trade", "A building", "A letter", "A timetable"],
        correctIndex: 0,
        explanation: "Ecommerce is online trade.",
      },
      {
        _id: "question-2",
        learningText: "Learn another idea.",
        learningVideoUrl: `https://youtu.be/${VIDEO_ID}`,
        learningVideoPlacement: "beforeLearnFirst",
        prompt: "What supports ecommerce?",
        options: ["A website", "Only paper", "No devices", "No customers"],
        correctIndex: 0,
        explanation: "A website can support ecommerce.",
      },
    ],
  });

  assert.equal(payload.questions[0].learningVideoUrl, "");
  assert.equal(
    payload.questions[0].learningVideoPlacement,
    DEFAULT_LEARNING_VIDEO_PLACEMENT,
  );
  assert.equal(
    payload.questions[1].learningVideoUrl,
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  );
  assert.equal(payload.questions[1].learningVideoPlacement, "beforeLearnFirst");
});
