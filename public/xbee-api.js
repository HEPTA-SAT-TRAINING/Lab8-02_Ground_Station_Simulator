const START_DELIMITER = 0x7E;
const DEFAULT_MAX_FRAME_LENGTH = 8192;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value || []);
}

function copyRange(bytes, start, end) {
  return bytes.slice(start, end);
}

function apiChecksum(frameData) {
  const sum = frameData.reduce((total, byte) => (total + byte) & 0xFF, 0);
  return (0xFF - sum) & 0xFF;
}

function isValidApiChecksum(frameData, checksum) {
  const sum = frameData.reduce((total, byte) => (total + byte) & 0xFF, checksum);
  return (sum & 0xFF) === 0xFF;
}

export function encodeApiFrame(frameDataInput) {
  const frameData = asBytes(frameDataInput);
  if (frameData.length === 0 || frameData.length > 0xFFFF) {
    throw new RangeError("XBee API frame data must be 1 to 65535 bytes");
  }

  const result = new Uint8Array(frameData.length + 4);
  result[0] = START_DELIMITER;
  result[1] = (frameData.length >> 8) & 0xFF;
  result[2] = frameData.length & 0xFF;
  result.set(frameData, 3);
  result[result.length - 1] = apiChecksum(frameData);
  return result;
}

function parseReceiveFrame(frameData) {
  const frameType = frameData[0];

  if (frameType === 0x80 && frameData.length >= 11) {
    return {
      kind: "receive",
      frameType,
      source64: copyRange(frameData, 1, 9),
      source16: null,
      rssiDbm: -frameData[9],
      options: frameData[10],
      payload: copyRange(frameData, 11),
    };
  }

  if (frameType === 0x81 && frameData.length >= 5) {
    return {
      kind: "receive",
      frameType,
      source64: null,
      source16: copyRange(frameData, 1, 3),
      rssiDbm: -frameData[3],
      options: frameData[4],
      payload: copyRange(frameData, 5),
    };
  }

  if (frameType === 0x90 && frameData.length >= 12) {
    return {
      kind: "receive",
      frameType,
      source64: copyRange(frameData, 1, 9),
      source16: copyRange(frameData, 9, 11),
      rssiDbm: null,
      options: frameData[11],
      payload: copyRange(frameData, 12),
    };
  }

  if (frameType === 0x91 && frameData.length >= 18) {
    return {
      kind: "receive",
      frameType,
      source64: copyRange(frameData, 1, 9),
      source16: copyRange(frameData, 9, 11),
      rssiDbm: null,
      options: frameData[17],
      payload: copyRange(frameData, 18),
    };
  }

  return null;
}

export function parseApiFrameData(frameDataInput) {
  const frameData = asBytes(frameDataInput);
  if (frameData.length === 0) return null;

  const receive = parseReceiveFrame(frameData);
  if (receive) return receive;

  if (frameData[0] === 0x88 && frameData.length >= 5) {
    const command = String.fromCharCode(frameData[2], frameData[3]);
    const commandData = copyRange(frameData, 5);
    return {
      kind: "at-response",
      frameType: 0x88,
      frameId: frameData[1],
      command,
      status: frameData[4],
      commandData,
      rssiDbm: command === "DB" && frameData[4] === 0 && commandData.length > 0
        ? -commandData[0]
        : null,
    };
  }

  return {
    kind: "other",
    frameType: frameData[0],
    frameData: copyRange(frameData, 0),
  };
}

export class XBeeApiParser {
  constructor({ maxFrameLength = DEFAULT_MAX_FRAME_LENGTH } = {}) {
    this.maxFrameLength = maxFrameLength;
    this.buffer = [];
  }

  reset() {
    this.buffer = [];
  }

  push(chunkInput) {
    const chunk = asBytes(chunkInput);
    if (chunk.length === 0) return [];
    this.buffer.push(...chunk);

    const frames = [];
    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf(START_DELIMITER);
      if (start < 0) {
        this.buffer = [];
        break;
      }
      if (start > 0) this.buffer.splice(0, start);
      if (this.buffer.length < 3) break;

      const frameLength = (this.buffer[1] << 8) | this.buffer[2];
      if (frameLength < 1 || frameLength > this.maxFrameLength) {
        this.buffer.shift();
        continue;
      }

      const totalLength = frameLength + 4;
      if (this.buffer.length < totalLength) break;

      const frameData = new Uint8Array(this.buffer.slice(3, 3 + frameLength));
      const checksum = this.buffer[3 + frameLength];
      if (!isValidApiChecksum(frameData, checksum)) {
        // A corrupt length or checksum can hide a later valid delimiter. Drop
        // only the current delimiter and search again instead of losing data.
        this.buffer.shift();
        continue;
      }

      this.buffer.splice(0, totalLength);
      const parsed = parseApiFrameData(frameData);
      if (parsed) frames.push(parsed);
    }

    return frames;
  }
}

function nextFrameIdValue(frameId) {
  const value = Number(frameId) & 0xFF;
  return value === 0 ? 1 : value;
}

export function buildLocalAtCommand(command, frameId = 1) {
  const normalized = String(command || "").toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(normalized)) {
    throw new TypeError("XBee local AT command must contain exactly two ASCII characters");
  }

  return encodeApiFrame(new Uint8Array([
    0x08,
    nextFrameIdValue(frameId),
    normalized.charCodeAt(0),
    normalized.charCodeAt(1),
  ]));
}

function requireAddress(address, expectedLength, label) {
  const bytes = asBytes(address);
  if (bytes.length !== expectedLength) {
    throw new TypeError(`${label} must contain ${expectedLength} bytes`);
  }
  return bytes;
}

export function buildTransmitRequest(receiveFrame, payloadInput, frameId = 1) {
  if (!receiveFrame || receiveFrame.kind !== "receive") {
    throw new TypeError("A previously received XBee API frame is required");
  }

  const payload = asBytes(payloadInput);
  const id = nextFrameIdValue(frameId);
  let frameData;

  if (receiveFrame.frameType === 0x80) {
    const destination64 = requireAddress(receiveFrame.source64, 8, "64-bit destination");
    frameData = new Uint8Array(11 + payload.length);
    frameData.set([0x00, id], 0);
    frameData.set(destination64, 2);
    frameData[10] = 0x00;
    frameData.set(payload, 11);
  } else if (receiveFrame.frameType === 0x81) {
    const destination16 = requireAddress(receiveFrame.source16, 2, "16-bit destination");
    frameData = new Uint8Array(5 + payload.length);
    frameData.set([0x01, id], 0);
    frameData.set(destination16, 2);
    frameData[4] = 0x00;
    frameData.set(payload, 5);
  } else {
    const destination64 = requireAddress(receiveFrame.source64, 8, "64-bit destination");
    const destination16 = receiveFrame.source16 && receiveFrame.source16.length === 2
      ? receiveFrame.source16
      : new Uint8Array([0xFF, 0xFE]);
    frameData = new Uint8Array(14 + payload.length);
    frameData.set([0x10, id], 0);
    frameData.set(destination64, 2);
    frameData.set(destination16, 10);
    frameData[12] = 0x00;
    frameData[13] = 0x00;
    frameData.set(payload, 14);
  }

  return encodeApiFrame(frameData);
}
