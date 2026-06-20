"use client";

import { useEffect, useRef, useState } from "react";
import { createStoragePath, type CaseLabel } from "@/lib/cases";
import { downsampleFloat32ToMono16k, encodePcm16Wav } from "@/lib/audio/wav";
import { FINISH_STEPS, ORIGINAL_TEST_TASKS } from "@/lib/guide";
import { normalizeUsername, shouldCreateNewUid } from "@/lib/identity";
import { getLabDisplayState, type LabStatus } from "@/lib/lab-state";
import { getBrowserSupabase } from "@/lib/supabase/client";
import {
  formatWakeDetectionStatus,
  isWakeDetected,
  type WakeDetectionResult,
} from "@/lib/wake-detection";

const UID_KEY = "loona_record_uid";
const USERNAME_KEY = "loona_record_username";
const WAKE_POLL_INTERVAL_MS = 240;
const WAKE_FLASH_MS = 5000;

type LogLine = {
  id: string;
  className: "g" | "r" | "y";
  text: string;
};

type SessionStats = {
  uploads: number;
  real_pos: number;
  real_neg: number;
};

export function RecorderApp() {
  const [uid, setUid] = useState("");
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<LabStatus>("idle");
  const [statusText, setStatusText] = useState("照左侧清单念念看 —— 变绿就是识别到了");
  const [done, setDone] = useState(() => ORIGINAL_TEST_TASKS.map(() => false));
  const [activeTaskIndex, setActiveTaskIndex] = useState(0);
  const [introOpen, setIntroOpen] = useState(true);
  const [finishOpen, setFinishOpen] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [clock, setClock] = useState("0:00");
  const [previewUrl, setPreviewUrl] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [stats, setStats] = useState<SessionStats>({ uploads: 0, real_pos: 0, real_neg: 0 });

  const monitorRef = useRef<LiveAudioMonitor | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const wakeFlashTimerRef = useRef<number | null>(null);
  const wakePollTimerRef = useRef<number | null>(null);
  const wakeSessionIdRef = useRef("");
  const wakeDetectorDisabledRef = useRef(false);
  const lastWakeAtRef = useRef(0);
  const wakeAudioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const existingUid = window.localStorage.getItem(UID_KEY);
    const nextUid = shouldCreateNewUid(existingUid) ? crypto.randomUUID() : existingUid || crypto.randomUUID();
    window.localStorage.setItem(UID_KEY, nextUid);
    setUid(nextUid);
    setUsername(window.localStorage.getItem(USERNAME_KEY) ?? "");

    return () => {
      monitorRef.current?.stop();
      if (flashTimerRef.current) {
        window.clearTimeout(flashTimerRef.current);
      }
      if (wakeFlashTimerRef.current) {
        window.clearTimeout(wakeFlashTimerRef.current);
      }
      if (wakeAudioContextRef.current) {
        void wakeAudioContextRef.current.close();
      }
      stopWakePolling();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (username) {
      window.localStorage.setItem(USERNAME_KEY, username);
    }
  }, [username]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!startedAtRef.current) {
        setClock("0:00");
        return;
      }
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setClock(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey) {
        return;
      }
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        void saveCase("real_pos");
      }
      if (event.key === "q" || event.key === "Q") {
        event.preventDefault();
        void saveCase("real_neg");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function startListening() {
    const cleanName = normalizeUsername(username);
    if (!cleanName || cleanName === "anonymous") {
      setStatus("error");
      setStatusText("先填名字，英文/拼音/昵称都可以");
      return;
    }

    try {
      setUsername(cleanName);
      const monitor = await createLiveAudioMonitor((level) => setMicLevel(level));
      monitorRef.current = monitor;
      startedAtRef.current = Date.now();
      wakeSessionIdRef.current = `${uid || crypto.randomUUID()}-${Date.now()}`;
      wakeDetectorDisabledRef.current = false;
      lastWakeAtRef.current = 0;
      setStatus("listening");
      setStatusText("开始吧！照左侧清单念；变绿就是识别到了");
      setIntroOpen(false);
      addLog("y", "已开启麦克风，开始测试");
      scheduleWakePolling();
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "无法启动麦克风");
    }
  }

  function stopWakePolling() {
    if (wakePollTimerRef.current) {
      window.clearTimeout(wakePollTimerRef.current);
      wakePollTimerRef.current = null;
    }
  }

  function scheduleWakePolling(delayMs = WAKE_POLL_INTERVAL_MS) {
    stopWakePolling();
    wakePollTimerRef.current = window.setTimeout(() => {
      wakePollTimerRef.current = null;
      void pollWakeDetector();
    }, delayMs);
  }

  async function pollWakeDetector() {
    const monitor = monitorRef.current;
    if (!monitor || wakeDetectorDisabledRef.current) {
      return;
    }
    let sentRequest = false;

    try {
      const captured = monitor.drainForDetection();
      const minSamples = captured.sampleRate * captured.channelCount * 0.12;
      if (captured.samples.length >= minSamples) {
        const pcm = downsampleFloat32ToMono16k(captured.samples, {
          inputSampleRate: captured.sampleRate,
          channelCount: captured.channelCount,
        });
        if (pcm.length >= 160) {
          const wav = encodePcm16Wav(pcm, 16000);
          sentRequest = true;
          const { response, result } = await requestWakeDetection(wav, wakeSessionIdRef.current || "default");

          if (!response.ok) {
            wakeDetectorDisabledRef.current = true;
            const message = result.error || "实时检测服务不可用";
            addLog(response.status === 503 ? "y" : "r", `实时检测已停用：${message}`);
            return;
          }

          if (isWakeDetected(result)) {
            showWakeDetected(result);
          }
        }
      }
    } catch (error) {
      wakeDetectorDisabledRef.current = true;
      addLog("r", `实时检测已停用：${error instanceof Error ? error.message : "请求失败"}`);
    } finally {
      if (monitorRef.current && !wakeDetectorDisabledRef.current) {
        scheduleWakePolling(sentRequest ? 0 : WAKE_POLL_INTERVAL_MS);
      }
    }
  }

  function showWakeDetected(result: WakeDetectionResult) {
    const now = Date.now();
    if (now - lastWakeAtRef.current < WAKE_FLASH_MS) {
      return;
    }
    lastWakeAtRef.current = now;
    const detail = formatWakeDetectionStatus(result);
    setStatus("wake_detected");
    setStatusText(detail);
    addLog("g", `🟢 唤醒 ${detail}`);
    playWakeTone();

    if (wakeFlashTimerRef.current) {
      window.clearTimeout(wakeFlashTimerRef.current);
    }
    wakeFlashTimerRef.current = window.setTimeout(() => {
      setStatus((current) => (current === "wake_detected" ? "listening" : current));
      setStatusText("照左侧清单念念看 —— 变绿就是识别到了");
    }, WAKE_FLASH_MS);
  }

  function playWakeTone() {
    try {
      const AudioCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        return;
      }
      const audioContext = wakeAudioContextRef.current ?? new AudioCtor();
      wakeAudioContextRef.current = audioContext;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.28, audioContext.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.28);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch {
      // Audio feedback is best-effort; visual wake state is the source of truth.
    }
  }

  async function saveCase(label: CaseLabel) {
    const monitor = monitorRef.current;
    if (!monitor) {
      setStatus("error");
      setStatusText("先点「开始测试」开启麦克风");
      return;
    }

    const captured = monitor.capture();
    if (captured.samples.length < captured.sampleRate * captured.channelCount * 0.35) {
      setStatus("error");
      setStatusText("最近音频太短，先说一句再标记");
      return;
    }

    const task = ORIGINAL_TEST_TASKS[activeTaskIndex] ?? ORIGINAL_TEST_TASKS[0];
    const cleanName = normalizeUsername(username);
    const caseId = crypto.randomUUID();
    const createdAt = new Date();
    const storagePath = createStoragePath({ label, uid, caseId, date: createdAt });

    setStatus("saving");
    setStatusText(label === "real_pos" ? "正在上传正样本" : "正在上传负样本");

    try {
      const pcm = downsampleFloat32ToMono16k(captured.samples, {
        inputSampleRate: captured.sampleRate,
        channelCount: captured.channelCount,
      });
      const wav = encodePcm16Wav(pcm, 16000);
      const durationMs = Math.round((pcm.length / 16000) * 1000);
      const blob = new Blob([toArrayBuffer(wav)], { type: "audio/wav" });
      const supabase = getBrowserSupabase();

      const { error: uploadError } = await supabase.storage.from("loona-recordings").upload(storagePath, blob, {
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
        prompt_key: `task-${activeTaskIndex + 1}`,
        prompt_text: `${task.text} ${task.note}`,
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

      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      setPreviewUrl(URL.createObjectURL(blob));
      setStats((current) => ({
        uploads: current.uploads + 1,
        real_pos: current.real_pos + (label === "real_pos" ? 1 : 0),
        real_neg: current.real_neg + (label === "real_neg" ? 1 : 0),
      }));
      setStatus("sample_saved");
      setStatusText(label === "real_pos" ? `已存正样本 #${stats.real_pos + 1}` : `已存负样本 #${stats.real_neg + 1}`);
      addLog(label === "real_pos" ? "g" : "r", `${label === "real_pos" ? "漏识别→正样本" : "误唤醒→负样本"} (${durationMs}ms)`);
      flashSuccess();
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "上传失败");
      addLog("r", error instanceof Error ? error.message : "上传失败");
    }
  }

  function toggleTask(index: number) {
    setActiveTaskIndex(index);
    setDone((current) => {
      const next = [...current];
      next[index] = !next[index];
      if (next.every(Boolean)) {
        setFinishOpen(true);
      }
      return next;
    });
  }

  function resetSessionView() {
    setStats({ uploads: 0, real_pos: 0, real_neg: 0 });
    setLogs([]);
    setStatus("listening");
    setStatusText("已清空本页计数；云端已上传数据不会删除");
  }

  function resetUid() {
    const nextUid = crypto.randomUUID();
    window.localStorage.setItem(UID_KEY, nextUid);
    setUid(nextUid);
    setStatusText("已生成新的 UID");
  }

  function addLog(className: LogLine["className"], text: string) {
    const time = new Date().toLocaleTimeString("en-GB");
    setLogs((current) => [{ id: crypto.randomUUID(), className, text: `[${time}] ${text}` }, ...current].slice(0, 80));
  }

  function flashSuccess() {
    if (flashTimerRef.current) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setStatus((current) => (current === "sample_saved" ? "listening" : current));
      setStatusText("照左侧清单念念看 —— 变绿就是识别到了");
    }, 1600);
  }

  const doneCount = done.filter(Boolean).length;
  const progress = `${(doneCount / ORIGINAL_TEST_TASKS.length) * 100}%`;
  const displayState = getLabDisplayState(status);

  return (
    <>
      <aside className="lab-guide">
        <h3>测试清单(照着念)</h3>
        <div className="lab-user">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="名字: 英文 / 拼音 / 昵称"
          />
          <button type="button" onClick={resetUid}>重置 UID</button>
        </div>
        <div className="lab-uid">{uid || "生成 UID 中"}</div>
        <div className="lab-progress"><div style={{ width: progress }} /></div>
        <div className="lab-tasks">
          {ORIGINAL_TEST_TASKS.map((task, index) => (
            <button
              key={task.text}
              type="button"
              className={`lab-task${done[index] ? " done" : ""}${activeTaskIndex === index ? " active" : ""}`}
              onClick={() => toggleTask(index)}
            >
              {done[index] ? "✅ " : "⬜ "}
              {task.text}
              <span>{task.note}</span>
            </button>
          ))}
        </div>
        <div className="lab-hint">
          <b>每句之间停 2-3 秒</b><br />
          说了 Loona 却没醒 → <kbd>Ctrl</kbd>+<kbd>W</kbd> 或点绿按钮<br />
          误唤醒 → <kbd>Ctrl</kbd>+<kbd>Q</kbd> 或点黄按钮<br />
          云端会记录你的 UID 和用户名，管理员可在 <a href="/admin">/admin</a> 导出 collected.zip
        </div>
        <button className="lab-finish" type="button" onClick={() => setFinishOpen(true)}>
          我测完了，怎么发回？
        </button>
      </aside>

      <main className={displayState.appClassName}>
        <div className="lab-big">{displayState.headline}</div>
        <div className="lab-meta">{statusText}</div>
        <div className="lab-micwrap">
          <div>麦克风音量(说话时应跳动；不动=浏览器没收到声音)</div>
          <div className="lab-meter"><div style={{ width: `${Math.round(micLevel * 100)}%` }} /></div>
        </div>
        <div className="lab-actions">
          <span>
            <button className="lab-btn lab-btn-w" type="button" disabled={status === "saving"} onClick={() => void saveCase("real_pos")}>
              说了没醒(存正样本)
            </button>
            <em>或按 <kbd>Ctrl</kbd>+<kbd>W</kbd></em>
          </span>
          <span>
            <button className="lab-btn lab-btn-q" type="button" disabled={status === "saving"} onClick={() => void saveCase("real_neg")}>
              误唤醒(存负样本)
            </button>
            <em>或按 <kbd>Ctrl</kbd>+<kbd>Q</kbd></em>
          </span>
        </div>
        <button className="lab-clear" type="button" onClick={resetSessionView}>清空本页计数重来</button>
        {previewUrl ? <audio className="lab-player" src={previewUrl} controls /> : null}
      </main>

      <div className="lab-counts">
        上传 <span>{stats.uploads}</span> · 正W <span>{stats.real_pos}</span> · 负Q <span>{stats.real_neg}</span><br />
        <span>{clock}</span>
      </div>
      <div className="lab-log">
        {logs.map((item) => <div key={item.id} className={item.className}>{item.text}</div>)}
      </div>

      {introOpen ? (
        <div className="lab-modal">
          <div className="lab-card">
            <h2>Loona 唤醒测试 · 约 10 分钟</h2>
            <label>
              名字
              <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="英文 / 拼音 / 昵称" />
            </label>
            <ol>
              <li>点下面按钮开始，同时开启麦克风</li>
              <li>照左侧清单一步步念，每句之间停 2-3 秒</li>
              <li>说了却没醒按 Ctrl+W；误唤醒按 Ctrl+Q</li>
            </ol>
            <button className="lab-go" type="button" onClick={() => void startListening()}>开始测试</button>
          </div>
        </div>
      ) : null}

      {finishOpen ? (
        <div className="lab-modal">
          <div className="lab-card">
            <h2>测完啦</h2>
            <div>你这次：上传 <b>{stats.uploads}</b> · 正样本 <b>{stats.real_pos}</b> · 负样本 <b>{stats.real_neg}</b></div>
            <ol>
              <li>云端已经收到，不需要压缩本地 collected</li>
              <li>管理员打开 /admin，输入 token</li>
              <li>点击导出 collected.zip</li>
            </ol>
            <div className="lab-local-note">{FINISH_STEPS.join(" / ")}</div>
            <button className="lab-go" type="button" onClick={() => setFinishOpen(false)}>继续测</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

type CapturedAudio = {
  samples: Float32Array;
  sampleRate: number;
  channelCount: number;
};

type LiveAudioMonitor = {
  capture: () => CapturedAudio;
  drainForDetection: () => CapturedAudio;
  stop: () => void;
};

async function createLiveAudioMonitor(onLevel: (level: number) => void): Promise<LiveAudioMonitor> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持麦克风录音");
  }
  const AudioCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    throw new Error("当前浏览器不支持 AudioContext");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const audioContext = new AudioCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const channelCount = source.channelCount || 1;
  const processor = audioContext.createScriptProcessor(4096, channelCount, 1);
  const chunks: Float32Array[] = [];
  const detectionChunks: Float32Array[] = [];
  const maxSamples = Math.ceil(audioContext.sampleRate * channelCount * 4);
  const maxDetectionSamples = Math.ceil(audioContext.sampleRate * channelCount * 2);
  let totalSamples = 0;
  let detectionSamples = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const frameCount = input.length;
    const interleaved = new Float32Array(frameCount * channelCount);
    let energy = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = input.getChannelData(channel)[frame] ?? 0;
        interleaved[frame * channelCount + channel] = sample;
        energy += sample * sample;
      }
    }
    chunks.push(interleaved);
    totalSamples += interleaved.length;
    detectionChunks.push(interleaved);
    detectionSamples += interleaved.length;
    while (totalSamples > maxSamples && chunks.length > 1) {
      totalSamples -= chunks.shift()?.length ?? 0;
    }
    while (detectionSamples > maxDetectionSamples && detectionChunks.length > 1) {
      detectionSamples -= detectionChunks.shift()?.length ?? 0;
    }
    onLevel(Math.min(1, Math.sqrt(energy / interleaved.length) * 8));
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    capture() {
      const samples = new Float32Array(totalSamples);
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
    drainForDetection() {
      const samples = new Float32Array(detectionSamples);
      let offset = 0;
      for (const chunk of detectionChunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      detectionChunks.length = 0;
      detectionSamples = 0;
      return {
        samples,
        sampleRate: audioContext.sampleRate,
        channelCount,
      };
    },
    stop() {
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}

function toArrayBuffer(bytes: Uint8Array) {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

async function requestWakeDetection(wav: Uint8Array, sessionId: string) {
  const directUrl = process.env.NEXT_PUBLIC_WAKE_API_URL?.replace(/\/$/, "");
  if (directUrl) {
    try {
      const directResponse = await fetch(`${directUrl}/wake`, {
        method: "POST",
        mode: "cors",
        headers: {
          "bypass-tunnel-reminder": "true",
          "Content-Type": "application/json",
          "x-loona-session-id": sessionId,
        },
        body: JSON.stringify({ audio_wav_base64: bytesToBase64(wav) }),
      });
      const directResult = await readWakeJson(directResponse);
      return {
        response: directResponse,
        result: directResult,
      };
    } catch {
      // localtunnel can return an HTML reminder page to browser clients.
      // Fall back to the server-side proxy, which is slower but stable.
    }
  }

  const response = await fetch("/api/wake", {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      "x-loona-session-id": sessionId,
    },
    body: toArrayBuffer(wav),
  });

  return {
    response,
    result: await readWakeJson(response),
  };
}

async function readWakeJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as WakeDetectionResult;
  } catch {
    throw new Error(`wake detector returned non-JSON (${response.status})`);
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}
