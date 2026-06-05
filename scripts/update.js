import fs from "node:fs/promises";

const API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;

// -------------------------
// YouTube helpers
// -------------------------

async function getUploadsPlaylistId() {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.search = new URLSearchParams({
    key: API_KEY,
    id: CHANNEL_ID,
    part: "contentDetails"
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`channels.list failed: ${res.status}`);

  const data = await res.json();
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
}

async function fetchPlaylistVideos(playlistId, pageToken = null) {
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");

  url.search = new URLSearchParams({
    key: API_KEY,
    playlistId,
    part: "snippet,contentDetails",
    maxResults: "50",
    ...(pageToken ? { pageToken } : {})
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`playlistItems.list failed: ${res.status}`);

  return res.json();
}

async function fetchAllUploads(playlistId) {
  let pageToken = null;
  const videos = [];

  while (true) {
    const data = await fetchPlaylistVideos(playlistId, pageToken);

    for (const item of data.items || []) {
      const snippet = item.snippet;
      const content = item.contentDetails;

      if (!snippet?.title) continue;

      videos.push({
        id: content.videoId,
        title: snippet.title,
        description: snippet.description || "",
        publishedAt: snippet.publishedAt
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return videos;
}

// -------------------------
// Parsing
// -------------------------

function extractHashtags(text) {
  return [...text.matchAll(/#([A-Za-z0-9_-]+)/g)]
    .map(m => m[1].toLowerCase());
}

function detectStage(title) {
  const t = title.toLowerCase();

  if (t.includes("final")) return "final";
  if (t.includes("semi")) return "semifinal";
  if (t.includes("quarter")) return "quarterfinal";

  const round = t.match(/round\s*(\d+)/i);
  if (round) return `round:${Number(round[1])}`;

  return "unknown";
}

function getOrderKey(video) {
  const stage = video.stage;

  if (stage.startsWith("round:")) {
    return Number(stage.split(":")[1]);
  }

  if (stage === "quarterfinal") return 1000;
  if (stage === "semifinal") return 2000;
  if (stage === "final") return 3000;

  return 9999;
}

// -------------------------
// Overrides (manual fixes)
// -------------------------

async function loadOverrides() {
  try {
    const raw = await fs.readFile("data/overrides.json", "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// -------------------------
// Main build
// -------------------------

async function main() {
  const uploadsId = await getUploadsPlaylistId();
  console.log("Upload playlist id:", uploadsId)
  const videos = await fetchAllUploads(uploadsId);

  const overrides = await loadOverrides();

  // enrich
  for (const v of videos) {
    const tags = extractHashtags(`${v.title}\n${v.description}`);
    v.hashtags = tags;
    v.stage = detectStage(v.title);
    v.orderKey = getOrderKey(v);
  }

  // group by hashtag
  const tournaments = {};

  for (const v of videos) {
    if (v.hashtags.length === 0) continue;

    for (const tag of v.hashtags) {
      tournaments[tag] ??= [];
      tournaments[tag].push(v);
    }
  }

  // sort + apply overrides
  for (const [tag, list] of Object.entries(tournaments)) {
    list.sort((a, b) => {
      const oa = a.orderKey - b.orderKey;
      if (oa !== 0) return oa;

      return new Date(a.publishedAt) - new Date(b.publishedAt);
    });

    // manual override order (if exists)
    const overrideOrder = overrides[tag]?.videoOrder;
    if (overrideOrder?.length) {
      const map = new Map(list.map(v => [v.id, v]));
      tournaments[tag] = overrideOrder
        .map(id => map.get(id))
        .filter(Boolean);
    }
  }

  // stable output (important for git diffs)
  const output = Object.fromEntries(
    Object.entries(tournaments).sort(([a], [b]) => a.localeCompare(b))
  );

  await fs.writeFile(
    "data/tournaments.json",
    JSON.stringify(output, null, 2)
  );

  console.log("Updated tournaments:", Object.keys(output));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});