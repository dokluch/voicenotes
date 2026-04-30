export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import "@/lib/schema";

export async function GET() {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                           AS note_count,
         COALESCE(SUM(duration_ms), 0)                     AS total_duration_ms,
         COALESCE(SUM(transcribe_cost_usd + cleanup_cost_usd), 0)
                                                           AS total_cost_usd,
         COALESCE(SUM(prompt_tokens), 0)                   AS total_prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)               AS total_completion_tokens
       FROM ledger`,
    )
    .get() as {
      note_count: number;
      total_duration_ms: number;
      total_cost_usd: number;
      total_prompt_tokens: number;
      total_completion_tokens: number;
    };

  return NextResponse.json(row);
}
