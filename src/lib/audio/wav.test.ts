import { describe, expect, test } from "vitest";
import { downsampleFloat32ToMono16k, encodePcm16Wav } from "./wav";

function ascii(bytes: Uint8Array, start: number, length: number) {
  return new TextDecoder("ascii").decode(bytes.slice(start, start + length));
}

function u16(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe("encodePcm16Wav", () => {
  test("writes a mono 16 kHz PCM16 WAV header", () => {
    const wav = encodePcm16Wav(new Int16Array([0, 32767, -32768]), 16000);

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(u16(wav, 20)).toBe(1);
    expect(u16(wav, 22)).toBe(1);
    expect(u32(wav, 24)).toBe(16000);
    expect(u16(wav, 34)).toBe(16);
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(u32(wav, 40)).toBe(6);
  });

  test("clamps and writes PCM samples little-endian", () => {
    const wav = encodePcm16Wav(new Int16Array([1, -2]), 16000);

    expect(u16(wav, 44)).toBe(1);
    expect(u16(wav, 46)).toBe(65534);
  });
});

describe("downsampleFloat32ToMono16k", () => {
  test("downsamples stereo float samples to mono PCM16 at 16 kHz", () => {
    const input = new Float32Array([
      1, 1,
      0.5, 0.5,
      -0.5, -0.5,
      -1, -1,
      0, 0,
      0.25, 0.25,
    ]);

    const pcm = downsampleFloat32ToMono16k(input, {
      inputSampleRate: 48000,
      channelCount: 2,
    });

    expect([...pcm]).toEqual([32767, -32768]);
  });

  test("rejects invalid sample rates and channel counts", () => {
    expect(() =>
      downsampleFloat32ToMono16k(new Float32Array([0]), {
        inputSampleRate: 0,
        channelCount: 1,
      }),
    ).toThrow("inputSampleRate");
    expect(() =>
      downsampleFloat32ToMono16k(new Float32Array([0]), {
        inputSampleRate: 48000,
        channelCount: 0,
      }),
    ).toThrow("channelCount");
  });
});
