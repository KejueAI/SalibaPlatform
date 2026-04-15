import { db } from "@/db";
import { cars, instagramSources, events } from "@/db/schema";
import { eq } from "drizzle-orm";
import { scrapeReels, extractStockId } from "./apify";
import { extractCarData } from "./llm";
import type { VideoObject } from "@/db/schema";

export async function runInstagramPipeline(accountHandle: string) {
  const source = await db.query.instagramSources.findFirst({
    where: eq(instagramSources.accountHandle, accountHandle),
  });

  if (!source || !source.isActive) {
    throw new Error(`Instagram source ${accountHandle} not found or inactive`);
  }

  // Create event
  const [event] = await db
    .insert(events)
    .values({ type: "instagram_poll", status: "running" })
    .returning();

  try {
    const reels = await scrapeReels(accountHandle);

    // Filter to new reels
    const newReels = source.lastReelTimestamp
      ? reels.filter((r) => new Date(r.timestamp) > source.lastReelTimestamp!)
      : reels;

    let matched = 0;
    let skippedNoStockId = 0;
    let skippedLlmError = 0;
    let newCars = 0;
    let updatedCars = 0;

    for (const reel of newReels) {
      const comments = (reel.latestComments || []).map((c) => c.text);
      const stockId = extractStockId(reel.caption || "", comments);

      if (!stockId) {
        skippedNoStockId++;
        continue;
      }

      matched++;

      // Extract car data via LLM — skip on failure, don't kill entire pipeline
      let carData: Record<string, unknown>;
      try {
        carData = await extractCarData(
          stockId,
          reel.caption || "",
          reel.transcript || ""
        );
      } catch (err) {
        console.error(
          `LLM extraction failed for reel ${reel.shortCode} (stock ${stockId}):`,
          (err as Error).message
        );
        skippedLlmError++;
        continue;
      }

      // Build video object
      const video: VideoObject = {
        video_id: `ig_${reel.id}`,
        platform: "instagram",
        caption: reel.caption || "",
        transcript: reel.transcript || "",
        posted_at: reel.timestamp,
        permalink: reel.url,
        thumbnail_url: reel.displayUrl || "",
        fetched_at: new Date().toISOString(),
      };

      // Upsert
      const existing = await db.query.cars.findFirst({
        where: eq(cars.stockId, stockId),
      });

      if (existing) {
        // Append video (dedup by video_id), fill NULL fields only
        const existingVideos = (existing.videos as VideoObject[]) || [];
        const videoExists = existingVideos.some(
          (v) => v.video_id === video.video_id
        );
        const updatedVideos = videoExists
          ? existingVideos
          : [...existingVideos, video];

        await db
          .update(cars)
          .set({
            make: existing.make || (carData.make as string),
            model: existing.model || (carData.model as string),
            year: existing.year || (carData.year as number),
            trim: existing.trim || (carData.trim as string),
            color: existing.color || (carData.color as string),
            mileage: existing.mileage || (carData.mileage as number),
            price: existing.price || (carData.price as number),
            bodyType: existing.bodyType || (carData.body_type as string),
            drivetrain: existing.drivetrain || (carData.drivetrain as string),
            engine: existing.engine || (carData.engine as string),
            transmission:
              existing.transmission || (carData.transmission as string),
            description: existing.description || (carData.description as string),
            videos: updatedVideos,
            updatedAt: new Date(),
          })
          .where(eq(cars.id, existing.id));
        updatedCars++;
      } else {
        await db.insert(cars).values({
          stockId,
          make: (carData.make as string) || "Unknown",
          model: (carData.model as string) || "Unknown",
          year: (carData.year as number) || new Date().getFullYear(),
          trim: carData.trim as string,
          color: carData.color as string,
          mileage: carData.mileage as number,
          price: carData.price as number,
          bodyType: carData.body_type as string,
          drivetrain: carData.drivetrain as string,
          engine: carData.engine as string,
          transmission: carData.transmission as string,
          description: carData.description as string,
          source: "instagram",
          videos: [video],
        });
        newCars++;
      }
    }

    // Update source timestamp
    const latestTimestamp =
      newReels.length > 0
        ? new Date(
            Math.max(...newReels.map((r) => new Date(r.timestamp).getTime()))
          )
        : source.lastReelTimestamp;

    await db
      .update(instagramSources)
      .set({
        lastPolledAt: new Date(),
        lastReelTimestamp: latestTimestamp,
        updatedAt: new Date(),
      })
      .where(eq(instagramSources.id, source.id));

    // Update event
    await db
      .update(events)
      .set({
        status: "completed",
        summary: {
          reels_found: reels.length,
          new_reels: newReels.length,
          matched,
          skipped_no_stock_id: skippedNoStockId,
          skipped_llm_error: skippedLlmError,
          new_cars: newCars,
          updated_cars: updatedCars,
        },
        completedAt: new Date(),
      })
      .where(eq(events.id, event.id));

    return {
      reels_found: reels.length,
      matched,
      skipped_no_stock_id: skippedNoStockId,
      skipped_llm_error: skippedLlmError,
      new_cars: newCars,
      updated_cars: updatedCars,
    };
  } catch (err) {
    await db
      .update(events)
      .set({
        status: "failed",
        errorMessage: (err as Error).message,
        completedAt: new Date(),
      })
      .where(eq(events.id, event.id));
    throw err;
  }
}
