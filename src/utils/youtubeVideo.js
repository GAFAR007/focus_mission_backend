/**
 * WHAT:
 * Safely parses teacher-supplied YouTube learning-video URLs and placement
 * values without fetching remote metadata or accepting arbitrary embed HTML.
 * WHY:
 * Mission questions may carry optional supporting media, but only recognized
 * YouTube video IDs should cross the persistence and student-view boundary.
 * HOW:
 * Normalize common YouTube share URL shapes to one canonical watch URL and
 * constrain placement to the three teacher-facing learning positions.
 */

const DEFAULT_LEARNING_VIDEO_PLACEMENT = "afterLearnFirst";
const LEARNING_VIDEO_PLACEMENTS = new Set([
  "beforeLearnFirst",
  DEFAULT_LEARNING_VIDEO_PLACEMENT,
  "afterExplanation",
]);
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function normalizeUrlCandidate(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue || /[<>]/.test(rawValue)) {
    return "";
  }

  return /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : `https://${rawValue}`;
}

function isYouTubeHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "youtube.com" || normalized.endsWith(".youtube.com");
}

function firstPathSegment(pathname) {
  return String(pathname || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)[0] || "";
}

function parseYouTubeVideoUrl(value) {
  const candidate = normalizeUrlCandidate(value);
  if (!candidate) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  let videoId = "";

  if (hostname === "youtu.be" || hostname.endsWith(".youtu.be")) {
    videoId = firstPathSegment(parsed.pathname);
  } else if (isYouTubeHost(hostname)) {
    const firstSegment = firstPathSegment(parsed.pathname).toLowerCase();
    if (firstSegment === "watch") {
      videoId = String(parsed.searchParams.get("v") || "").trim();
    } else if (["shorts", "embed", "live"].includes(firstSegment)) {
      const segments = parsed.pathname
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
      videoId = segments[1] || "";
    }
  }

  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    return null;
  }

  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

function normalizeLearningVideoPlacement(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return DEFAULT_LEARNING_VIDEO_PLACEMENT;
  }
  return LEARNING_VIDEO_PLACEMENTS.has(normalized) ? normalized : null;
}

module.exports = {
  DEFAULT_LEARNING_VIDEO_PLACEMENT,
  LEARNING_VIDEO_PLACEMENTS,
  normalizeLearningVideoPlacement,
  parseYouTubeVideoUrl,
};
