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

// -------------------------
// Structure validation
// -------------------------

function isMatchVideo(title) {
  return /^(Round\s+\d+|Quarterfinals?|Semifinals?|Finals?)\s*\|\s*.+?\s+vs\s+.+?\s*\|\s*.+?\s*\|\s*#\w+$/i
    .test(title);
}

function isDraftVideo(title) {
  return /^Featured Draft\s+.+\s*\|\s*Draft\s*\|\s*#\w+$/i
    .test(title);
}

function isValidVideo(title) {
  return isMatchVideo(title) || isDraftVideo(title);
}

// -------------------------
// Parsing helpers
// -------------------------

function getEventId(title) {
  const match = title.match(/#(\w+)$/);
  return match ? match[1] : "unknown";
}

function detectStage(title) {
  const t = title.toLowerCase();

  const round = t.match(/^round\s+(\d+)/i);
  if (round) return { type: "round", value: Number(round[1]) };

  if (/quarterfinals?/.test(t)) return { type: "quarterfinal", value: 1000 };
  if (/semifinals?/.test(t)) return { type: "semifinal", value: 2000 };
  if (/finals?/.test(t)) return { type: "final", value: 3000 };

  if (/featured draft/.test(t)) return { type: "draft", value: 0 };

  return { type: "unknown", value: 9999 };
}

function getOrderKey(video) {
  return video.stage.value;
}

// -------------------------
// Main build
// -------------------------

async function fetchAllUploads(playlistId) {
  let pageToken = null;
  const videos = [];

  while (true) {
    const data = await fetchPlaylistVideos(playlistId, pageToken);

    for (const item of data.items || []) {
      const snippet = item.snippet;
      const content = item.contentDetails;

      if (!snippet?.title) continue;
      if (!isValidVideo(snippet.title)) continue;

      const title = snippet.title;

      const video = {
        id: content.videoId,
        title,
        description: snippet.description || "",
        publishedAt: snippet.publishedAt,
        event: getEventId(title),
        stage: detectStage(title)
      };

      video.orderKey = getOrderKey(video);

      videos.push(video);
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return videos;
}

// -------------------------
// Main
// -------------------------

async function main() {
  const uploadsId = await getUploadsPlaylistId();
  const videos = await fetchAllUploads(uploadsId);

  // group by event (NO hashtags)
  const tournaments = {};

  for (const v of videos) {
    const key = v.event;

    tournaments[key] ??= [];
    tournaments[key].push(v);
  }

  // sort each event
  for (const list of Object.values(tournaments)) {
    list.sort((a, b) => {
      const oa = a.orderKey - b.orderKey;
      if (oa !== 0) return oa;

      return new Date(a.publishedAt) - new Date(b.publishedAt);
    });
  }

  // stable output
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
