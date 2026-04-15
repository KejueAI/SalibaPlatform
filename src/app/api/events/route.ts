import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { events } from "@/db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const perPage = parseInt(searchParams.get("perPage") || "20");
  const type = searchParams.get("type");

  const conditions = type ? [eq(events.type, type)] : [];
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * perPage;

  const [results, [{ count: total }]] = await Promise.all([
    db
      .select()
      .from(events)
      .where(whereClause)
      .orderBy(desc(events.createdAt))
      .limit(perPage)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(events)
      .where(whereClause),
  ]);

  return NextResponse.json({
    events: results,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}
