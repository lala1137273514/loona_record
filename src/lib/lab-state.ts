export type LabStatus =
  | "idle"
  | "listening"
  | "saving"
  | "sample_saved"
  | "wake_detected"
  | "error";

export function getLabDisplayState(status: LabStatus) {
  if (status === "wake_detected") {
    return {
      appClassName: "lab-app green",
      headline: "🟢 识别到 Loona",
    };
  }

  if (status === "error") {
    return {
      appClassName: "lab-app",
      headline: "⚠️ 出错",
    };
  }

  return {
    appClassName: "lab-app",
    headline: "🔴 待命",
  };
}
