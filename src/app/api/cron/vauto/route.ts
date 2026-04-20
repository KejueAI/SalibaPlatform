import { NextRequest, NextResponse } from "next/server";
import { processVautoFile } from "@/lib/vauto";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import fs from "fs";
import path from "path";

const UPLOAD_DIR = process.env.VAUTO_UPLOAD_DIR || "/home/vauto/uploads";
const MAX_CSV_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const apiKey = process.env.TOOL_API_KEY;
  const bearerOk = apiKey && authHeader === `Bearer ${apiKey}`;

  if (!bearerOk) {
    const reqHeaders = await headers();
    const session = await auth.api.getSession({ headers: reqHeaders });
    if (!session || session.user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    if (!fs.existsSync(UPLOAD_DIR)) {
      return NextResponse.json(
        { error: "Upload directory does not exist" },
        { status: 404 }
      );
    }

    // Find ALL CSV files, sorted oldest first (process in order)
    const files = fs
      .readdirSync(UPLOAD_DIR)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => ({
        name: f,
        path: path.join(UPLOAD_DIR, f),
        size: fs.statSync(path.join(UPLOAD_DIR, f)).size,
        mtime: fs.statSync(path.join(UPLOAD_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime);

    if (files.length === 0) {
      return NextResponse.json({ message: "No CSV files found" });
    }

    const results = [];

    for (const file of files) {
      // Size check
      if (file.size > MAX_CSV_SIZE) {
        results.push({
          file: file.name,
          error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB > 50MB limit)`,
        });
        continue;
      }

      try {
        const result = await processVautoFile(file.path);
        results.push({ file: file.name, ...result });
      } catch (err) {
        results.push({
          file: file.name,
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({ processed: results.length, results });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
