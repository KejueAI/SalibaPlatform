import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { cars } from "@/db/schema";
import { sql, and, eq, gte, lte, ilike } from "drizzle-orm";
import type { VideoObject } from "@/db/schema";

export async function POST(request: NextRequest) {
  // API key auth
  const authHeader = request.headers.get("authorization");
  const apiKey = process.env.TOOL_API_KEY;
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { query, filters = {}, limit = 5 } = body;

  if (typeof limit !== "number" || typeof filters !== "object") {
    return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
  }

  const conditions: ReturnType<typeof eq>[] = [];

  // Status filter (default: available)
  conditions.push(eq(cars.status, filters.status || "available"));

  // Structured filters
  if (filters.make) conditions.push(ilike(cars.make, `%${String(filters.make).replace(/%/g, "")}%`));
  if (filters.model) conditions.push(ilike(cars.model, `%${String(filters.model).replace(/%/g, "")}%`));
  if (filters.year_min) conditions.push(gte(cars.year, Number(filters.year_min)));
  if (filters.year_max) conditions.push(lte(cars.year, Number(filters.year_max)));
  if (filters.min_price) conditions.push(gte(cars.price, Number(filters.min_price)));
  if (filters.max_price) conditions.push(lte(cars.price, Number(filters.max_price)));

  // Build the query
  const clampedLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);

  let results;
  if (query && String(query).trim()) {
    // FTS query — sanitize: strip Postgres tsquery operators to prevent injection
    const sanitized = String(query)
      .replace(/[&|!<>():*\\'"]/g, " ")
      .trim();

    if (!sanitized) {
      return NextResponse.json({ results: [], total_count: 0 });
    }

    const tsQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => w + ":*")
      .join(" & ");

    results = await db
      .select({
        id: cars.id,
        stockId: cars.stockId,
        make: cars.make,
        model: cars.model,
        year: cars.year,
        trim: cars.trim,
        color: cars.color,
        mileage: cars.mileage,
        price: cars.price,
        status: cars.status,
        bodyType: cars.bodyType,
        drivetrain: cars.drivetrain,
        engine: cars.engine,
        description: cars.description,
        videos: cars.videos,
        rank: sql<number>`ts_rank(search_vector, to_tsquery('english', ${tsQuery}))`.as(
          "rank"
        ),
      })
      .from(cars)
      .where(
        and(
          sql`search_vector @@ to_tsquery('english', ${tsQuery})`,
          ...conditions
        )
      )
      .orderBy(
        sql`ts_rank(search_vector, to_tsquery('english', ${tsQuery})) DESC`
      )
      .limit(clampedLimit);
  } else {
    results = await db
      .select({
        id: cars.id,
        stockId: cars.stockId,
        make: cars.make,
        model: cars.model,
        year: cars.year,
        trim: cars.trim,
        color: cars.color,
        mileage: cars.mileage,
        price: cars.price,
        status: cars.status,
        bodyType: cars.bodyType,
        drivetrain: cars.drivetrain,
        engine: cars.engine,
        description: cars.description,
        videos: cars.videos,
      })
      .from(cars)
      .where(and(...conditions))
      .orderBy(cars.updatedAt)
      .limit(clampedLimit);
  }

  // Shape response
  const shaped = results.map((r) => {
    const videos = (r.videos as VideoObject[]) || [];
    const latestVideo = videos.sort(
      (a, b) =>
        new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime()
    )[0];

    // Filter by video criteria if needed
    if (filters.has_video && videos.length === 0) return null;
    if (filters.video_posted_within_days && latestVideo) {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - filters.video_posted_within_days);
      if (new Date(latestVideo.posted_at) < daysAgo) return null;
    }

    return {
      stock_id: r.stockId,
      make: r.make,
      model: r.model,
      year: r.year,
      trim: r.trim,
      color: r.color,
      mileage: r.mileage,
      price: r.price,
      status: r.status,
      body_type: r.bodyType,
      drivetrain: r.drivetrain,
      engine: r.engine,
      description: r.description,
      video_count: videos.length,
      latest_video_date: latestVideo?.posted_at?.split("T")[0] || null,
      latest_video_permalink: latestVideo?.permalink || null,
    };
  }).filter(Boolean);

  return NextResponse.json({
    results: shaped,
    total_count: shaped.length,
  });
}
