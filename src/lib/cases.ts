export const CASE_LABELS = ["real_pos", "real_neg"] as const;

export type CaseLabel = (typeof CASE_LABELS)[number];

export type Prompt = {
  key: string;
  text: string;
  hint: string;
  recommendedLabel: CaseLabel;
};

export type RecordingCase = {
  id: string;
  uid: string;
  username: string;
  label: CaseLabel;
  prompt_key: string;
  prompt_text: string;
  storage_bucket: string;
  storage_path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  mime_type: string;
  client_created_at: string | null;
  created_at: string;
};

export const DEFAULT_PROMPTS: Prompt[] = [
  {
    key: "bare-loona",
    text: "Loona",
    hint: "单独说 3 次，每次停 2 秒",
    recommendedLabel: "real_pos",
  },
  {
    key: "hey-loona",
    text: "Hey Loona",
    hint: "单独说 3 次，每次停 2 秒",
    recommendedLabel: "real_pos",
  },
  {
    key: "cn-head-weather",
    text: "Loona, 今天天气怎么样",
    hint: "中文句首",
    recommendedLabel: "real_pos",
  },
  {
    key: "cn-tail-clothes",
    text: "你觉得这件衣服好看吗 Loona",
    hint: "中文句尾",
    recommendedLabel: "real_pos",
  },
  {
    key: "en-head-weather",
    text: "Loona, what is the weather today",
    hint: "English head",
    recommendedLabel: "real_pos",
  },
  {
    key: "en-tail-look",
    text: "Do you think this looks good Loona",
    hint: "English tail",
    recommendedLabel: "real_pos",
  },
  {
    key: "free",
    text: "自由发挥喊 Loona 的话",
    hint: "快说、慢说、远一点都可以",
    recommendedLabel: "real_pos",
  },
  {
    key: "negative-background",
    text: "正常打字、说别的话、放音乐，不要说 Loona",
    hint: "误唤醒时标 real_neg",
    recommendedLabel: "real_neg",
  },
];

export function sanitizeNamePart(value: string) {
  const ascii = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);

  return ascii || "unknown";
}

export function createStoragePath(input: {
  label: CaseLabel;
  uid: string;
  caseId: string;
  date: Date;
}) {
  return `${input.label}/${sanitizeNamePart(input.uid)}/${formatStorageTimestamp(input.date)}-${sanitizeNamePart(input.caseId)}.wav`;
}

export function exportFilenameForCase(row: Pick<RecordingCase, "id" | "uid" | "username" | "label" | "created_at">) {
  const prefix = row.label === "real_pos" ? "realpos" : "realneg";
  return [
    "collected",
    row.label,
    `${prefix}_${sanitizeNamePart(row.username)}_${shortId(row.uid)}_${formatExportTimestamp(
      new Date(row.created_at),
    )}_${shortId(row.id)}.wav`,
  ].join("/");
}

export function buildManifestCsv(rows: RecordingCase[]) {
  const header = [
    "id",
    "uid",
    "username",
    "label",
    "prompt_key",
    "prompt_text",
    "storage_path",
    "duration_ms",
    "sample_rate",
    "channels",
    "created_at",
    "export_path",
  ];
  const lines = rows.map((row) =>
    [
      row.id,
      row.uid,
      row.username,
      row.label,
      row.prompt_key,
      row.prompt_text,
      row.storage_path,
      String(row.duration_ms),
      String(row.sample_rate),
      String(row.channels),
      row.created_at,
      exportFilenameForCase(row),
    ]
      .map(csvCell)
      .join(","),
  );

  return [header.join(","), ...lines].join("\n");
}

function csvCell(value: string) {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function shortId(value: string) {
  return sanitizeNamePart(value).slice(0, 8) || "unknown";
}

function formatStorageTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatExportTimestamp(date: Date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}
