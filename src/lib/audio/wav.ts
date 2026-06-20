const TARGET_SAMPLE_RATE = 16000;

export type DownsampleOptions = {
  inputSampleRate: number;
  channelCount: number;
};

function floatToPcm16(sample: number) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

export function downsampleFloat32ToMono16k(
  input: Float32Array,
  options: DownsampleOptions,
) {
  const { inputSampleRate, channelCount } = options;
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    throw new Error("inputSampleRate must be a positive number");
  }
  if (!Number.isInteger(channelCount) || channelCount <= 0) {
    throw new Error("channelCount must be a positive integer");
  }
  if (input.length === 0) {
    return new Int16Array();
  }

  const inputFrameCount = Math.floor(input.length / channelCount);
  const outputFrameCount = Math.max(
    1,
    Math.floor((inputFrameCount * TARGET_SAMPLE_RATE) / inputSampleRate),
  );
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const output = new Int16Array(outputFrameCount);

  for (let outIndex = 0; outIndex < outputFrameCount; outIndex += 1) {
    const sourceFrame = Math.min(inputFrameCount - 1, Math.floor(outIndex * ratio));
    let mono = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      mono += input[sourceFrame * channelCount + channel] ?? 0;
    }
    output[outIndex] = floatToPcm16(mono / channelCount);
  }

  return output;
}

export function encodePcm16Wav(samples: Int16Array, sampleRate = TARGET_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * bytesPerSample, samples[index] ?? 0, true);
  }

  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
