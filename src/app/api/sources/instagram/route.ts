import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { instagramSources } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { runInstagramPipeline } from "@/lib/instagram";

async function getSession() {
  return await auth.api.getSession({ headers: await headers() });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sources = await db.select().from(instagramSources);
  return NextResponse.json(sources);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  // Action: poll now
  if (body.action === "poll") {
    try {
      const result = await runInstagramPipeline(body.accountHandle);
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 500 }
      );
    }
  }

  // Create or update source
  if (body.id) {
    const [updated] = await db
      .update(instagramSources)
      .set({
        displayName: body.displayName,
        pollingInterval: body.pollingInterval,
        isActive: body.isActive,
        updatedAt: new Date(),
      })
      .where(eq(instagramSources.id, body.id))
      .returning();
    return NextResponse.json(updated);
  }

  const [source] = await db
    .insert(instagramSources)
    .values({
      accountHandle: body.accountHandle,
      displayName: body.displayName,
      pollingInterval: body.pollingInterval || 60,
    })
    .returning();

  return NextResponse.json(source, { status: 201 });
}
