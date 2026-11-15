import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { StreamReceiver } from "../public/hepta-image-receiver.js";
import { createDemoTelemetryLines } from "../public/demo-telemetry.js";
import {
  XBeeApiParser,
  buildLocalAtCommand,
  buildTransmitRequest,
  encodeApiFrame,
} from "../public/xbee-api.js";
import { crc16CcittFalse as crc16 } from "../public/vendor/hepta-serial-monitor/docs/crc16.js";
import {
  FORMAT_JPEG,
  PACKET_TYPE_DATA,
  PACKET_TYPE_END,
  PACKET_TYPE_PARITY,
  PACKET_TYPE_START,
} from "../public/vendor/hepta-serial-monitor/docs/packet.js";

function le16(value) {
  return [value & 0xFF, (value >> 8) & 0xFF];
}

function packet(type, sequence, total, payload = new Uint8Array()) {
  const crcInput = new Uint8Array(7 + payload.length);
  crcInput.set([type, ...le16(sequence), ...le16(total), ...le16(payload.length)]);
  crcInput.set(payload, 7);
  return new Uint8Array([
    0x48, 0x50, type,
    ...le16(sequence), ...le16(total), ...le16(payload.length),
    ...le16(crc16(crcInput)),
    ...payload
  ]);
}

function concat(...chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const image = new Uint8Array([
  0xFF, 0xD8, 1, 2, 3, 4, 5, 6,
  7, 8, 9, 10, 11, 12, 0xFF, 0xD9
]);
const payloadSize = 8;
const dataCount = Math.ceil(image.length / payloadSize);
const total = dataCount + 3;
const startPayload = new Uint8Array([
  FORMAT_JPEG,
  ...le16(7),
  image.length, 0, 0, 0,
  ...le16(crc16(image)),
  ...le16(payloadSize)
]);
const data1 = image.slice(0, payloadSize);
const data2 = image.slice(payloadSize);
const parity = new Uint8Array(payloadSize);
for (let i = 0; i < data1.length; i++) parity[i] ^= data1[i];
for (let i = 0; i < data2.length; i++) parity[i] ^= data2[i];

const telemetryBefore = new TextEncoder().encode(
  "TEMP=23.40,BUS=3.780,V5=5.001,V3V3=3.301,SAP=4.120,ISOL=0.104,IBUS=0.217,ICHG=0.031\r\n",
);
const telemetryAfter = new TextEncoder().encode(
  "AX=0.01,AY=-0.03,AZ=9.80,GX=0.10,GY=0.20,GZ=-0.10,MX=21.00,MY=-4.00,MZ=38.00\r\n",
);
const stream = concat(
  telemetryBefore,
  new TextEncoder().encode("IMG_BEGIN\n"),
  packet(PACKET_TYPE_START, 0, total, startPayload),
  packet(PACKET_TYPE_START, 0, total, startPayload),
  packet(PACKET_TYPE_DATA, 1, total, data1),
  // DATA 2 is intentionally missing and must be recovered by parity.
  packet(PACKET_TYPE_PARITY, dataCount + 1, total, parity),
  packet(PACKET_TYPE_END, total - 1, total),
  new TextEncoder().encode("\nIMG_END\n"),
  telemetryAfter
);

const telemetryChunks = [];
let completed = null;
const errors = [];
const receiver = new StreamReceiver({
  onTelemetryBytes: bytes => telemetryChunks.push(bytes),
  onComplete: result => { completed = result; },
  onError: message => errors.push(message)
});

// Deliberately split marker, header, and payload at arbitrary boundaries.
const splitSizes = [3, 5, 1, 7, 2, 13, 4, 19, 6, 11, 17, 23, 29];
let offset = 0;
let splitIndex = 0;
while (offset < stream.length) {
  const size = splitSizes[splitIndex++ % splitSizes.length];
  receiver.push(stream.slice(offset, Math.min(stream.length, offset + size)));
  offset += size;
}

assert.equal(errors.length, 0, errors.join("; "));
assert.ok(completed, "image should complete");
assert.deepEqual(completed.image, image);
assert.equal(completed.meta.imageId, 7);
assert.equal(completed.recoveredSequence, 2);

const telemetry = concat(...telemetryChunks);
assert.ok(telemetry.length >= telemetryBefore.length + telemetryAfter.length);
assert.deepEqual(telemetry.slice(0, telemetryBefore.length), telemetryBefore);
assert.deepEqual(telemetry.slice(-telemetryAfter.length), telemetryAfter);

// A DATA packet with a bad packet CRC is discarded and recovered by parity.
const corruptData1 = packet(PACKET_TYPE_DATA, 1, total, data1);
corruptData1[corruptData1.length - 1] ^= 0x01;
const corruptStream = concat(
  new TextEncoder().encode("IMG_BEGIN\n"),
  packet(PACKET_TYPE_START, 0, total, startPayload),
  corruptData1,
  packet(PACKET_TYPE_DATA, 2, total, data2),
  packet(PACKET_TYPE_PARITY, dataCount + 1, total, parity),
  packet(PACKET_TYPE_END, total - 1, total)
);
let corruptionRecovered = null;
const warnings = [];
const corruptReceiver = new StreamReceiver({
  onComplete: result => { corruptionRecovered = result; },
  onWarning: message => warnings.push(message),
  onError: message => { throw new Error(message); }
});
corruptReceiver.push(corruptStream);
assert.ok(warnings.some(message => message.includes("CRC")));
assert.ok(corruptionRecovered);
assert.deepEqual(corruptionRecovered.image, image);
assert.equal(corruptionRecovered.recoveredSequence, 1);

// Two missing DATA packets exceed the parity recovery capability. The error is
// reported, and a later telemetry chunk is still delivered instead of stopping
// the receiver.
const unrecoverableErrors = [];
const telemetryAfterFailure = [];
const unrecoverableReceiver = new StreamReceiver({
  onTelemetryBytes: bytes => telemetryAfterFailure.push(bytes),
  onError: message => unrecoverableErrors.push(message),
});
unrecoverableReceiver.push(concat(
  new TextEncoder().encode("IMG_BEGIN\n"),
  packet(PACKET_TYPE_START, 0, total, startPayload),
  packet(PACKET_TYPE_PARITY, dataCount + 1, total, parity),
  packet(PACKET_TYPE_END, total - 1, total),
));
assert.ok(unrecoverableErrors.some(message => message.includes("Cannot recover image")));
unrecoverableReceiver.push(telemetryAfter);
assert.deepEqual(concat(...telemetryAfterFailure), telemetryAfter);

assert.equal(crc16(new TextEncoder().encode("123456789")), 0x29B1);

// XBee API mode exposes the receiver-side RSSI while preserving the original
// HEPTA RF payload. The stream parser must tolerate arbitrary serial chunks.
const xbeePayload = new TextEncoder().encode("TEMP=23.40,BUS=3.780\r\n");
const rx16ApiFrame = encodeApiFrame(new Uint8Array([
  0x81, 0x12, 0x34, 0x40, 0x01, ...xbeePayload,
]));
const xbeeParser = new XBeeApiParser();
assert.deepEqual(xbeeParser.push(rx16ApiFrame.slice(0, 2)), []);
assert.deepEqual(xbeeParser.push(rx16ApiFrame.slice(2, 7)), []);
const [rx16] = xbeeParser.push(rx16ApiFrame.slice(7));
assert.equal(rx16.kind, "receive");
assert.equal(rx16.frameType, 0x81);
assert.deepEqual(rx16.source16, new Uint8Array([0x12, 0x34]));
assert.equal(rx16.rssiDbm, -64);
assert.deepEqual(rx16.payload, xbeePayload);

const source64 = new Uint8Array([0x00, 0x13, 0xA2, 0x00, 0x41, 0x52, 0x53, 0x54]);
const rx64ApiFrame = encodeApiFrame(new Uint8Array([
  0x80, ...source64, 0x5D, 0x00, 0x61,
]));
const [rx64] = xbeeParser.push(rx64ApiFrame);
assert.equal(rx64.rssiDbm, -93);
assert.deepEqual(rx64.source64, source64);
assert.deepEqual(rx64.payload, new Uint8Array([0x61]));

// Newer 802.15.4 output (0x90) has no inline RSSI; ATDB supplies the RSSI of
// the most recently received RF packet.
const rx90ApiFrame = encodeApiFrame(new Uint8Array([
  0x90,
  ...source64,
  0x7D, 0x84,
  0x01,
  0x62,
]));
const [rx90] = xbeeParser.push(rx90ApiFrame);
assert.equal(rx90.kind, "receive");
assert.equal(rx90.rssiDbm, null);
assert.deepEqual(rx90.payload, new Uint8Array([0x62]));

const atDbResponse = encodeApiFrame(new Uint8Array([
  0x88, 0x22, 0x44, 0x42, 0x00, 0x4A,
]));
const [db] = xbeeParser.push(atDbResponse);
assert.equal(db.kind, "at-response");
assert.equal(db.command, "DB");
assert.equal(db.status, 0);
assert.equal(db.rssiDbm, -74);

const atDbRequest = buildLocalAtCommand("DB", 0x22);
const [atRequest] = xbeeParser.push(atDbRequest);
assert.equal(atRequest.kind, "other");
assert.deepEqual(atRequest.frameData, new Uint8Array([0x08, 0x22, 0x44, 0x42]));

const tx16Frame = buildTransmitRequest(rx16, new Uint8Array([0x70]), 0x33);
const [tx16] = xbeeParser.push(tx16Frame);
assert.deepEqual(
  tx16.frameData,
  new Uint8Array([0x01, 0x33, 0x12, 0x34, 0x00, 0x70]),
);

const tx64Frame = buildTransmitRequest(rx64, new Uint8Array([0x61]), 0x34);
const [tx64] = xbeeParser.push(tx64Frame);
assert.deepEqual(
  tx64.frameData,
  new Uint8Array([0x00, 0x34, ...source64, 0x00, 0x61]),
);

const corruptApiFrame = rx16ApiFrame.slice();
corruptApiFrame[corruptApiFrame.length - 1] ^= 0x01;
assert.deepEqual(xbeeParser.push(concat(corruptApiFrame, rx64ApiFrame)), [rx64]);

// Exercise the decoder that is actually embedded in ground-station.html.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const html = fs.readFileSync(new URL("../public/ground-station.html", import.meta.url), "utf8");

// The dashboard exposes non-destructive panel and graph selectors so dense
// layouts can be reduced without affecting the serial receiver.
assert.match(html, /id="panel-selector-trigger"/);
assert.match(html, /data-panel-toggle=/);
assert.match(html, /hepta-gs-visible-panels-v1/);
assert.match(html, /id="graph-selector-trigger"/);
assert.match(html, /data-graph-toggle=/);
assert.match(html, /hepta-gs-visible-graphs-v1/);
assert.match(html, /DEFAULT_VISIBLE_GRAPHS\s*=\s*new Set/);
assert.match(html, /id="image-receive-progress-bar"/);
assert.match(html, /imageReceiveProgressBar\.value/);
assert.match(html, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
assert.match(html, /updateRawSerialHexDisplay\(bytesToHex\(lineBytes\)\)/);
assert.match(html, /row\.timedOut = false;/);
assert.match(html, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => drawTrackingDisplays\(\)\)\)/);
assert.match(html, /solarArrayVoltageV: "SAP"/);
assert.match(html, /overscroll-behavior: contain/);
assert.match(html, /className = "bottom-resizer"/);
assert.match(html, /bottomPanelWidths/);
assert.match(html, /Waiting for RSSI data/);
assert.match(html, /DEMO_TELEMETRY_ENABLED/);
assert.match(html, /startDemoTelemetry\(\)/);
assert.match(html, /id="xbee-mode-select"/);
assert.match(html, /Extension mode \(AP=1\)/);
assert.match(html, /Basic mode \(AP=0\)/);
assert.match(html, /handleXbeeApiSerialBytes/);
assert.match(html, /\.image-receive-body[\s\S]*grid-template-rows: auto minmax\(240px, 1fr\)/);
assert.match(html, /\.image-receive-body[\s\S]*overscroll-behavior: contain/);
assert.match(html, /historyBounded/);
assert.match(html, /function graphEdgeLabel/);
assert.match(html, /grid-template-columns: minmax\(0, 1fr\) !important/);
assert.match(html, /grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\)/);
assert.match(html, /new ResizeObserver/);
assert.match(html, /\.app\s*\{[\s\S]*width: 100%/);
assert.match(html, /\.top-area > \*,[\s\S]*\.bottom-area > \*\s*\{[\s\S]*min-width: 0/);
assert.match(html, /function normalizeBottomWidths/);
assert.match(html, /command-log-command[\s\S]*min-width: 0/);
assert.match(html, /grid-template-rows: minmax\(360px, 1fr\) minmax\(280px, 1fr\)/);
assert.match(html, /\.mini-graph-canvas-wrap[\s\S]*min-height: 250px/);

// The command UI must accept the three single-byte Lab commands, including p.
const commandIdsSource = html.match(/commandIds:\s*{([\s\S]*?)}/)?.[1] || "";
const commandIds = Object.fromEntries(
  [...commandIdsSource.matchAll(/([abp]):\s*(0x[0-9a-f]+)/gi)]
    .map(match => [match[1], Number(match[2])]),
);
assert.deepEqual(Object.keys(commandIds).sort(), ["a", "b", "p"]);
assert.match(html, /placeholder="[^"]*a \/ b \/ p[^"]*"/);
assert.match(html, /id="command-input"[^>]*maxlength="1"/);
assert.match(html, /DIRECT_SERIAL_COMMAND_LINE_ENDING\s*=\s*""/);

const decoderSource = ["byteToHex", "readInt16BE", "decodeMode", "decodePacketTypeMode", "decodeHkPayload"]
  .map(name => extractFunction(html, name))
  .join("\n");
const decoderContext = {
  TELEMETRY_PACKET: { typeHk: 0x10, basicPayloadLength: 5, missionPayloadLength: 23, extendedPayloadLength: 35 }
};
vm.createContext(decoderContext);
vm.runInContext(decoderSource, decoderContext);
const payload = new Uint8Array(35);
payload[0] = 1;
payload.set([0x0B, 0xB8, 0x00, 0xFA], 1); // bus raw=3000, temperature=25.0 C
payload.set([0x13, 0x88, 0x0C, 0xE4, 0x10, 0x68], 23); // 5.000, 3.300, 4.200 V
payload.set([0x00, 0x7B, 0x01, 0xC8, 0x00, 0x4E], 29); // 0.123, 0.456, 0.078 A
decoderContext.input = payload;
const decoded = vm.runInContext("decodeHkPayload(input, 0x11)", decoderContext);
assert.equal(decoded.temperatureC, 25);
assert.equal(decoded.voltage5V, 5);
assert.equal(decoded.voltage3v3, 3.3);
assert.equal(decoded.solarArrayVoltageV, 4.2);
assert.equal(decoded.solarCurrentA, 0.123);
assert.equal(decoded.busCurrentA, 0.456);
assert.equal(decoded.chargeCurrentA, 0.078);
decoderContext.input = new Uint8Array([0x01, 0x02]);
assert.equal(vm.runInContext("decodeHkPayload(input, 0x11)", decoderContext), null);

// Exercise the production text parser with the exact Flight/Lab field names.
const textTelemetryState = {
  voltageV: null,
  temperatureC: null,
  voltage5V: null,
  voltage3v3: null,
  solarArrayVoltageV: null,
  solarCurrentA: null,
  busCurrentA: null,
  chargeCurrentA: null,
  accX: null,
  accY: null,
  accZ: null,
  gyroX: null,
  gyroY: null,
  gyroZ: null,
  magX: null,
  magY: null,
  magZ: null,
  receivedNumber: null,
};
let displayedTextTelemetry = null;
const textDecoderContext = {
  backendTelemetryState: textTelemetryState,
  isTelemetryDisplayAllowed: () => true,
  updateTelemetryDisplayFromObject: state => { displayedTextTelemetry = { ...state }; },
};
vm.createContext(textDecoderContext);
vm.runInContext(extractFunction(html, "updateTelemetryDisplayFromBackendText"), textDecoderContext);
textDecoderContext.input = "TEMP=23.40,BUS=3.780,V5=5.001,V3V3=3.301,SAP=4.120,ISOL=0.104,IBUS=0.217,ICHG=0.031";
assert.equal(vm.runInContext("updateTelemetryDisplayFromBackendText(input)", textDecoderContext), true);
assert.equal(displayedTextTelemetry.temperatureC, 23.4);
assert.equal(displayedTextTelemetry.voltageV, 3.78);
assert.equal(displayedTextTelemetry.voltage5V, 5.001);
assert.equal(displayedTextTelemetry.chargeCurrentA, 0.031);

textDecoderContext.input = "AX=0.01,AY=-0.03,AZ=9.80,GX=0.10,GY=0.20,GZ=-0.10,MX=21.00,MY=-4.00,MZ=38.00";
assert.equal(vm.runInContext("updateTelemetryDisplayFromBackendText(input)", textDecoderContext), true);
assert.equal(displayedTextTelemetry.accZ, 9.8);
assert.equal(displayedTextTelemetry.gyroZ, -0.1);
assert.equal(displayedTextTelemetry.magY, -4);

textDecoderContext.input = "TEMP=broken,UNKNOWN=12";
assert.equal(vm.runInContext("updateTelemetryDisplayFromBackendText(input)", textDecoderContext), false);
assert.equal(displayedTextTelemetry.temperatureC, 23.4);

// RSSI must survive arbitrary Web Serial chunk boundaries. The production
// handler buffers until LF before calling the production RSSI parser.
const displayedRssi = [];
const serialContext = {
  serialTextBuffer: "",
  rssiSerialTextBuffer: "",
  USE_SIMULATED_RSSI: false,
  TextEncoder,
  isTelemetryDisplayAllowed: () => true,
  updateTelemetryReceiveGate: () => true,
  updateRssiDisplay: value => displayedRssi.push(value),
  feedHexTextPacketStream: () => {},
  updateRawSerialHexDisplay: () => {},
  bytesToHex: () => "",
  updateTelemetryDisplayFromBackendText: () => true,
  updateCommandAckLog: () => {},
  incrementRxCommandCount: () => {},
};
vm.createContext(serialContext);
vm.runInContext([
  extractFunction(html, "normalizeRssiDbm"),
  extractFunction(html, "updateRssiFromReceivedText"),
  extractFunction(html, "handleReceiverRssiText"),
  extractFunction(html, "handleReceivedSerialText"),
].join("\n"), serialContext);

const demoLines = createDemoTelemetryLines(0);
assert.match(demoLines[0], /^RSSI=-\d+,TEMP=/);
serialContext.chunk = demoLines[0].slice(0, 4);
vm.runInContext("handleReceivedSerialText(chunk)", serialContext);
assert.deepEqual(displayedRssi, []);
serialContext.chunk = demoLines[0].slice(4);
vm.runInContext("handleReceivedSerialText(chunk)", serialContext);
assert.equal(displayedRssi.length, 1);
assert.equal(displayedRssi[0], -68);

serialContext.chunk = "DB=40\r\n";
vm.runInContext("handleReceivedSerialText(chunk)", serialContext);
assert.equal(displayedRssi.at(-1), -64);

console.log("HEPTA-SAT telemetry/image protocol tests passed");

// The radio/image stream must remain continuous across HK pass boundaries.
// In particular, IMG_BEGIN may be fragmented across AOS and JPEG may end
// after LOS. Only the telemetry callback is allowed to filter HK records.
let hkWindowOpen = false;
let boundaryImage = null;
const boundaryErrors = [];
const boundaryTelemetry = [];
const boundaryReceiver = new StreamReceiver({
  onTelemetryBytes: bytes => { if (hkWindowOpen) boundaryTelemetry.push(...bytes); },
  onComplete: result => { boundaryImage = result; },
  onError: message => boundaryErrors.push(message)
});
const routeContext = vm.createContext({
  imageStreamReceiver: boundaryReceiver,
  updateTelemetryReceiveGate: () => { throw new Error("Do not gate the raw photo stream"); }
});
vm.runInContext(extractFunction(html, "handleReceivedRadioPayload"), routeContext);
routeContext.handleReceivedRadioPayload(telemetryBefore);
routeContext.handleReceivedRadioPayload(new TextEncoder().encode("IMG_BE"));
hkWindowOpen = true;
routeContext.handleReceivedRadioPayload(concat(
  new TextEncoder().encode("GIN\n"),
  packet(PACKET_TYPE_START, 0, total, startPayload),
  packet(PACKET_TYPE_DATA, 1, total, data1)
));
assert.equal(boundaryReceiver.mode, "image");
hkWindowOpen = false;
routeContext.handleReceivedRadioPayload(concat(
  packet(PACKET_TYPE_PARITY, dataCount + 1, total, parity),
  packet(PACKET_TYPE_END, total - 1, total),
  new TextEncoder().encode("\nIMG_END\n"), telemetryAfter
));
assert.deepEqual(boundaryErrors, []);
assert.ok(boundaryImage, "Photo must complete after the HK window closes");
assert.deepEqual(boundaryImage.image, image);
assert.equal(boundaryImage.recoveredSequence, 2);
assert.equal(boundaryTelemetry.length, 0, "Out-of-window HK stays filtered");
hkWindowOpen = true;
routeContext.handleReceivedRadioPayload(telemetryAfter);
assert.ok(boundaryTelemetry.length >= telemetryAfter.length);
boundaryReceiver.reset();
console.log("HEPTA-SAT photo framing across AOS/LOS passed");
