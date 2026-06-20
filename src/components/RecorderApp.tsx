"use client";

import { useEffect, useRef, useState } from "react";
import { createStoragePath, DEFAULT_PROMPTS, type CaseLabel, type Prompt } from "@/lib/cases";
import { downsampleFloat32ToMono16k, encodePcm16Wav } from "@/lib/audio/wav";
import { normalizeUsername, shouldCreateNewUid } from "@/lib/identity";
import { getBrowserSupabase } from "@/lib/supabase/client";

const UID_KEY = "loona_record_uid";
const USERNAME_KEY = "loona_record_username";
const LABELS: CaseLabel[] = ["real_pos", "real_neg"];

type RecorderStatus = {
  kind: "idle" | "recording" | "ready" | "uploading" | "success" | "error";
  message: string;
};

type SessionStats = {
  uploads: number;
  failures: number;
  latestPath: string;
};

export function RecorderApp() {
  const [uid, setUid] = useState("");
  const [username, setUsername] = useState("");
  const [label, setLabel] = useState<CaseLabel>("real_pos");
  const [prompt, setPrompt] = useState<Prompt>(DEFAULT_PROMPTS[0]);
  const [status, setStatus] = useState<RecorderStatus>({
    kind: "idle",
    message: "输入名字后开始录制",
  });
  const [durationMs, setDurationMs] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [stats, setStats] = useState<SessionStats>({
    uploads: 0,
    failures: 0,
    latestPath: "",
  });

  const recorderRef = useRef<AudioRecorder | null>(null);
  const wavRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const existingUid = window.localStorage.getItem(UID_KEY);
    const nextUid = shouldCreateNewUid(existingUid) ? crypto.randomUUID() : existingUid || crypto.randomUUID();
    window.localStorage.setItem(UID_KEY, nextUid);
    setUid(nextUid);
    setUsername(window.localStorage.getItem(USERNAME_KEY) ?? "");
  }, []);

  useEffect(() => {
    if (username) {
      window.localStorage.setItem(USERNAME_KEY, username);
    }
  }, [username]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      void recorderRef.current?.stop();
    };
  }, [previewUrl]);

  async function startRecording() {
    try {
      setStatus({ kind: "recording", message: "录音中，完成后点停止" });
      setDurationMs(0);
      wavRef.current = null;
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl("");
      }

      const recorder = await createAudioRecorder();
      recorderRef.current = recorder;
      recorder.start();
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "无法启动麦克风",
      });
    }
  }

  async function stopRecording() {
    try {
      const recorder = recorderRef.current;
      if (!recorder) {
        return;
      }
      const captured = await recorder.stop();
      recorderRef.current = null;
      const pcm = downsampleFloat32ToMono16k(captured.samples, {
        inputSampleRate: captured.sampleRate,
        channelCount: captured.channelCount,
      });
      const wav = encodePcm16Wav(pcm, 16000);
      const ms = Math.round((pcm.length / 16000) * 1000);
      wavRef.current = wav;
      setDurationMs(ms);
      const blob = new Blob([toArrayBuffer(wav)], { type: "audio/wav" });
      setPreviewUrl(URL.createObjectURL(blob));
      setStatus({ kind: "ready", message: `已录制 ${Math.round(ms / 100) / 10}s，可试听或上传` });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "录音转换失败",
      });
    }
  }

  async function uploadCase() {
    const wav = wavRef.current;
    if (!wav) {
      setStatus({ kind: "error", message: "请先录音" });
      return;
    }

    const cleanName = normalizeUsername(username);
    const caseId = crypto.randomUUID();
    const createdAt = new Date();
    const storagePath = createStoragePath({
      label,
      uid,
      caseId,
      date: createdAt,
    });

    setStatus({ kind: "uploading", message: "上传中" });
    try {
      const supabase = getBrowserSupabase();
      const blob = new Blob([toArrayBuffer(wav)], { type: "audio/wav" });
      const { error: uploadError } = await supabase.storage
        .from("loona-recordings")
        .upload(storagePath, blob, {
          contentType: "audio/wav",
          upsert: false,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { error: insertError } = await supabase.from("recording_cases").insert({
        id: caseId,
        uid,
        username: cleanName,
        label,
        prompt_key: prompt.key,
        prompt_text: prompt.text,
        storage_bucket: "loona-recordings",
        storage_path: storagePath,
        duration_ms: durationMs,
        sample_rate: 16000,
        channels: 1,
        mime_type: "audio/wav",
        client_created_at: createdAt.toISOString(),
      });

      if (insertError) {
        throw insertError;
      }

      setUsername(cleanName);
      setStats((current) => ({
        uploads: current.uploads + 1,
        failures: current.failures,
        latestPath: storagePath,
      }));
      setStatus({ kind: "success", message: "上传完成" });
    } catch (error) {
      setStats((current) => ({
        ...current,
        failures: current.failures + 1,
      }));
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "上传失败",
      });
    }
  }

  function resetUid() {
    const nextUid = crypto.randomUUID();
    window.localStorage.setItem(UID_KEY, nextUid);
    setUid(nextUid);
    setStatus({ kind: "idle", message: "已生成新的 uid" });
  }

  const canRecord = uid && username.trim() && status.kind !== "recording" && status.kind !== "uploading";
  const canUpload = wavRef.current && status.kind !== "recording" && status.kind !== "uploading";

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Loona Record</p>
          <h1>协同录制台</h1>
        </div>
        <div className={`status status-${status.kind}`}>{status.message}</div>
      </section>

      <section className="grid">
        <div className="panel identity-panel">
          <h2>采集者</h2>
          <label className="field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="英文 / 拼音 / 昵称"
            />
          </label>
          <div className="uid-row">
            <code>{uid || "生成中"}</code>
            <button className="secondary" type="button" onClick={resetUid}>
              重置 UID
            </button>
          </div>
        </div>

        <div className="panel stats-panel">
          <h2>本次会话</h2>
          <div className="stats">
            <span>
              <strong>{stats.uploads}</strong>
              上传
            </span>
            <span>
              <strong>{stats.failures}</strong>
              失败
            </span>
          </div>
          <p className="muted breakable">{stats.latestPath || "暂无上传"}</p>
        </div>
      </section>

      <section className="workspace">
        <div className="panel prompt-panel">
          <div className="section-head">
            <h2>录制清单</h2>
            <select
              value={prompt.key}
              onChange={(event) => {
                const next = DEFAULT_PROMPTS.find((item) => item.key === event.target.value) ?? DEFAULT_PROMPTS[0];
                setPrompt(next);
                setLabel(next.recommendedLabel);
              }}
            >
              {DEFAULT_PROMPTS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.text}
                </option>
              ))}
            </select>
          </div>
          <div className="prompt-display">
            <p>{prompt.text}</p>
            <span>{prompt.hint}</span>
          </div>
          <div className="segments" role="group" aria-label="case label">
            {LABELS.map((item) => (
              <button
                key={item}
                type="button"
                className={label === item ? "active" : ""}
                onClick={() => setLabel(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="panel recorder-panel">
          <div className="controls">
            <button type="button" disabled={!canRecord} onClick={startRecording}>
              录音
            </button>
            <button type="button" disabled={status.kind !== "recording"} onClick={stopRecording}>
              停止
            </button>
            <button type="button" disabled={!canUpload} onClick={uploadCase}>
              上传
            </button>
          </div>
          {previewUrl ? (
            <audio className="player" src={previewUrl} controls />
          ) : (
            <div className="empty-player">录完后可在这里试听</div>
          )}
          <p className="muted">每条建议 1-4 秒。浏览器会上传 16 kHz mono PCM16 WAV。</p>
        </div>
      </section>
    </main>
  );
}

type CapturedAudio = {
  samples: Float32Array;
  sampleRate: number;
  channelCount: number;
};

type AudioRecorder = {
  start: () => void;
  stop: () => Promise<CapturedAudio>;
};

async function createAudioRecorder(): Promise<AudioRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持麦克风录音");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, source.channelCount || 1, 1);
  const chunks: Float32Array[] = [];
  const channelCount = source.channelCount || 1;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const frameCount = input.length;
    const interleaved = new Float32Array(frameCount * channelCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        interleaved[frame * channelCount + channel] = input.getChannelData(channel)[frame] ?? 0;
      }
    }
    chunks.push(interleaved);
  };

  return {
    start() {
      source.connect(processor);
      processor.connect(audioContext.destination);
    },
    async stop() {
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const samples = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        samples,
        sampleRate: audioContext.sampleRate,
        channelCount,
      };
    },
  };
}

function toArrayBuffer(bytes: Uint8Array) {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}
