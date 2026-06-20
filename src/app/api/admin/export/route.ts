import JSZip from "jszip";
import { assertAdminRequest } from "@/lib/admin";
import { buildManifestCsv, exportFilenameForCase, type RecordingCase } from "@/lib/cases";
import { getServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = assertAdminRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from("recording_cases")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as RecordingCase[];
    const zip = new JSZip();
    zip.folder("collected/real_pos");
    zip.folder("collected/real_neg");

    for (const row of rows) {
      const { data: audio, error: downloadError } = await supabase.storage
        .from(row.storage_bucket)
        .download(row.storage_path);

      if (downloadError) {
        return Response.json(
          { error: `Failed to download ${row.storage_path}: ${downloadError.message}` },
          { status: 500 },
        );
      }

      zip.file(exportFilenameForCase(row), await audio.arrayBuffer());
    }

    zip.file("collected/manifest.csv", buildManifestCsv(rows));
    const body = await zip.generateAsync({ type: "arraybuffer" });

    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="collected.zip"',
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown server error" },
      { status: 500 },
    );
  }
}
