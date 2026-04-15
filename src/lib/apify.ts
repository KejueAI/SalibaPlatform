const APIFY_BASE = "https://api.apify.com/v2";

interface ApifyReel {
  id: string;
  shortCode: string;
  caption: string;
  transcript?: string | null;
  latestComments?: { text: string; ownerUsername: string }[];
  firstComment?: string;
  timestamp: string;
  url: string;
  displayUrl: string;
  videoUrl: string;
  likesCount: number;
  commentsCount: number;
  videoViewCount: number;
  videoPlayCount: number;
  hashtags: string[];
  mentions: string[];
  isPinned: boolean;
  videoDuration: number;
  ownerUsername: string;
}

export async function scrapeReels(
  username: string,
  limit: number = 5
): Promise<ApifyReel[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set");

  const runRes = await fetch(
    `${APIFY_BASE}/acts/apify~instagram-reel-scraper/runs?token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: [username],
        resultsLimit: limit,
      }),
    }
  );

  if (!runRes.ok) {
    const errBody = await runRes.text().catch(() => "");
    throw new Error(
      `Apify run failed (${runRes.status}): ${errBody.slice(0, 200)}`
    );
  }

  const run = await runRes.json();
  if (!run?.data?.id || !run?.data?.defaultDatasetId) {
    throw new Error(
      `Apify run response missing id/datasetId: ${JSON.stringify(run).slice(0, 200)}`
    );
  }

  const runId = run.data.id;
  const datasetId = run.data.defaultDatasetId;

  // Poll for completion — max 5 minutes, 5s intervals
  let status = run.data.status;
  const maxWait = 5 * 60 * 1000;
  const start = Date.now();

  while (
    (status === "RUNNING" || status === "READY") &&
    Date.now() - start < maxWait
  ) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(
      `${APIFY_BASE}/actor-runs/${runId}?token=${token}`
    );
    if (!pollRes.ok) {
      console.error(`Apify poll failed (${pollRes.status}), retrying...`);
      continue;
    }
    const pollData = await pollRes.json();
    status = pollData.data?.status;
  }

  if (status !== "SUCCEEDED") {
    throw new Error(`Apify run finished with status: ${status}`);
  }

  // Fetch dataset
  const dataRes = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}`
  );
  if (!dataRes.ok) {
    throw new Error(`Apify dataset fetch failed (${dataRes.status})`);
  }

  return dataRes.json();
}

export function extractStockId(
  caption: string,
  comments: string[]
): string | null {
  const patterns = [
    /(?:stock|stk)\s*#?\s*([A-Z]?\d{3,6})/i,
    /(?:#)([A-Z]\d{3,6})/,
    /\b([A-Z]\d{4,6})\b/,
  ];

  const allText = [caption, ...comments].join(" ");
  for (const pattern of patterns) {
    const match = allText.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}
