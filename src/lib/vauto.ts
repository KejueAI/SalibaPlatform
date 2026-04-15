import Papa from "papaparse";
import { db } from "@/db";
import { cars, events } from "@/db/schema";
import { eq, and, ne, notInArray } from "drizzle-orm";
import fs from "fs";
import path from "path";

const ARCHIVE_RETENTION_DAYS = 90;

// Default column mapping — can be customized
// Maps vAuto CSV column names → our DB field names
// Priority: more specific columns listed last overwrite earlier ones
const COLUMN_MAP: Record<string, string> = {
  // Stock ID
  StockNumber: "stockId",
  Stock: "stockId",
  "Stock #": "stockId",

  // Core vehicle info
  Make: "make",
  Model: "model",
  Year: "year",

  // Trim — vAuto uses "Series" for trim level (e.g. "Carrera S", "M Sport")
  Trim: "trim",
  Series: "trim",

  // Color — prefer "Exterior Base Color" (simpler: "Red", "White")
  // over "Color" (verbose: "Regatta Red Pearl/Silver Stone Metallic")
  Color: "color",
  "Ext Color": "color",
  "Exterior Color": "color",
  "Exterior Base Color": "color",

  // Mileage
  Miles: "mileage",
  Mileage: "mileage",
  Odometer: "mileage",

  // Price — "Other Price" is sometimes MSRP, "Price" is the listing price
  "Other Price": "price",
  "Internet Price": "price",
  "Selling Price": "price",
  "List Price": "price",
  Price: "price",

  // Body type
  "Body Style": "bodyType",
  "Body Type": "bodyType",
  Body: "bodyType",

  // Drivetrain
  Drivetrain: "drivetrain",
  "Drive Type": "drivetrain",
  "Drivetrain Desc": "drivetrain",

  // Engine
  Engine: "engine",
  "Engine Description": "engine",

  // Transmission
  Transmission: "transmission",

  // VIN
  VIN: "vin",

  // Description — vAuto's "Autowriter Description" is a ready-made summary
  "Autowriter Description": "description",
};

function mapRow(row: Record<string, string>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [csvCol, dbCol] of Object.entries(COLUMN_MAP)) {
    if (row[csvCol] !== undefined && row[csvCol] !== "") {
      mapped[dbCol] = row[csvCol];
    }
  }
  if (mapped.year) mapped.year = parseInt(mapped.year as string, 10);
  if (mapped.mileage)
    mapped.mileage = parseInt(
      (mapped.mileage as string).replace(/[^0-9]/g, ""),
      10
    );
  if (mapped.price)
    mapped.price = parseInt(
      (mapped.price as string).replace(/[^0-9]/g, ""),
      10
    );
  return mapped;
}

function cleanOldArchives(archiveDir: string) {
  try {
    if (!fs.existsSync(archiveDir)) return;

    const cutoff = Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(archiveDir);

    for (const file of files) {
      const filePath = path.join(archiveDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned old archive: ${file}`);
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
  } catch (err) {
    console.error("Archive cleanup error:", err);
  }
}

function archiveFile(filePath: string, archiveDir: string) {
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const archiveName = `${new Date().toISOString().split("T")[0]}_${path.basename(filePath)}`;
  const archivePath = path.join(archiveDir, archiveName);

  try {
    fs.renameSync(filePath, archivePath);
  } catch {
    // Rename can fail across filesystems — fall back to copy+delete
    fs.copyFileSync(filePath, archivePath);
    fs.unlinkSync(filePath);
  }
}

export async function processVautoFile(filePath: string) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error("CSV file is empty");
  }

  const csvText = fs.readFileSync(filePath, "utf-8");
  const { data, errors } = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (errors.length > 0) {
    console.error("CSV parse errors:", errors.slice(0, 5));
  }

  if (data.length === 0) {
    throw new Error("CSV file has no data rows");
  }

  // Create event
  const [event] = await db
    .insert(events)
    .values({ type: "vauto_import", status: "running" })
    .returning();

  let newCount = 0;
  let updatedCount = 0;
  let soldCount = 0;
  const processedStockIds: string[] = [];
  const errorList: string[] = [];

  for (const row of data) {
    try {
      const mapped = mapRow(row);
      if (!mapped.stockId || !mapped.make || !mapped.model || !mapped.year) {
        errorList.push(
          `Skipped row — missing required fields: ${JSON.stringify(row).slice(0, 100)}`
        );
        continue;
      }

      processedStockIds.push(mapped.stockId as string);

      const existing = await db.query.cars.findFirst({
        where: eq(cars.stockId, mapped.stockId as string),
      });

      if (existing) {
        await db
          .update(cars)
          .set({
            make: mapped.make as string,
            model: mapped.model as string,
            year: mapped.year as number,
            trim: (mapped.trim as string) || existing.trim,
            color: (mapped.color as string) || existing.color,
            mileage: (mapped.mileage as number) || existing.mileage,
            price: (mapped.price as number) || existing.price,
            bodyType: (mapped.bodyType as string) || existing.bodyType,
            drivetrain: (mapped.drivetrain as string) || existing.drivetrain,
            engine: (mapped.engine as string) || existing.engine,
            transmission:
              (mapped.transmission as string) || existing.transmission,
            vin: (mapped.vin as string) || existing.vin,
            description:
              (mapped.description as string) || existing.description,
            status: "available",
            source: "vauto",
            vautoRaw: row,
            updatedAt: new Date(),
          })
          .where(eq(cars.id, existing.id));
        updatedCount++;
      } else {
        await db.insert(cars).values({
          stockId: mapped.stockId as string,
          make: mapped.make as string,
          model: mapped.model as string,
          year: mapped.year as number,
          trim: mapped.trim as string,
          color: mapped.color as string,
          mileage: mapped.mileage as number,
          price: mapped.price as number,
          bodyType: mapped.bodyType as string,
          drivetrain: mapped.drivetrain as string,
          engine: mapped.engine as string,
          transmission: mapped.transmission as string,
          vin: mapped.vin as string,
          description: mapped.description as string,
          source: "vauto",
          vautoRaw: row,
        });
        newCount++;
      }
    } catch (err) {
      errorList.push(`Error processing row: ${(err as Error).message}`);
    }
  }

  // Mark missing cars as sold
  if (processedStockIds.length > 0) {
    const soldResult = await db
      .update(cars)
      .set({ status: "sold", updatedAt: new Date() })
      .where(
        and(
          ne(cars.status, "sold"),
          eq(cars.source, "vauto"),
          notInArray(cars.stockId, processedStockIds)
        )
      )
      .returning();
    soldCount = soldResult.length;
  }

  // Update event
  await db
    .update(events)
    .set({
      status: "completed",
      summary: {
        rows: data.length,
        new: newCount,
        updated: updatedCount,
        sold: soldCount,
        errors: errorList.slice(0, 20), // Cap stored errors
      },
      completedAt: new Date(),
    })
    .where(eq(events.id, event.id));

  // Archive processed file
  const archiveDir = path.join(path.dirname(filePath), "..", "archive");
  archiveFile(filePath, archiveDir);

  // Clean old archives (>90 days)
  cleanOldArchives(archiveDir);

  return {
    rows: data.length,
    new: newCount,
    updated: updatedCount,
    sold: soldCount,
    errors: errorList,
  };
}
