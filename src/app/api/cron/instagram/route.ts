import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { instagramSources } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runInstagramPipeline } from "@/lib/instagram";

export async function POST(request: NextRequest) {
  // Auth required — fail closed
  const authHeader = request.headers.get("authorization");
  const apiKey = process.env.TOOL_API_KEY;
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const activeSources = await db.query.instagramSources.findMany({
      where: eq(instagramSources.isActive, true),
    });

    const results = [];
    for (const source of activeSources) {
      try {
        const result = await runInstagramPipeline(source.accountHandle);
        results.push({ account: source.accountHandle, ...result });
      } catch (err) {
        results.push({
          account: source.accountHandle,
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
