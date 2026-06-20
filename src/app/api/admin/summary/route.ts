import { assertAdminRequest } from "@/lib/admin";
import { type RecordingCase } from "@/lib/cases";
import { getServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ContributorSummary = {
  uid: string;
  username: string;
  count: number;
};

export async function GET(request: Request) {
  const authError = assertAdminRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from("recording_cases")
      .select("uid, username, label")
      .order("created_at", { ascending: false });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as Pick<RecordingCase, "uid" | "username" | "label">[];
    const byLabel = { real_pos: 0, real_neg: 0 };
    const contributorMap = new Map<string, ContributorSummary>();

    for (const row of rows) {
      byLabel[row.label] += 1;
      const existing = contributorMap.get(row.uid);
      if (existing) {
        existing.count += 1;
      } else {
        contributorMap.set(row.uid, {
          uid: row.uid,
          username: row.username,
          count: 1,
        });
      }
    }

    return Response.json({
      total: rows.length,
      byLabel,
      byContributor: [...contributorMap.values()].sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown server error" },
      { status: 500 },
    );
  }
}
