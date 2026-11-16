import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/ground-station.html", import.meta.url), "utf8");
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const body = html.indexOf(") {", start) + 2;
  let end = body + 1, depth = 1;
  while (depth && end < html.length) {
    if (html[end] === "{") depth++;
    if (html[end] === "}") depth--;
    end++;
  }
  return html.slice(start, end);
}
function load(context, names) {
  vm.createContext(context);
  vm.runInContext(names.map(extract).join("\n"), context);
  return context;
}
const element = (textContent = "stale") => ({ textContent, className: "", dataset: {}, hidden: false, removeAttribute() {} });
const base = { connected: true, hasPass: true, aosMs: 1000, losMs: 2000, nowMs: 1500, elevationDeg: 30 };
const pure = load({ Number, AOS_LOS_ELEVATION_THRESHOLD_DEG: 5 }, ["evaluateTelemetryPassWindow"]);
for (const [change, state] of [
  [{ connected: false }, "disconnected"], [{ hasPass: false }, "no-pass"],
  [{ aosMs: NaN }, "no-pass"], [{ losMs: 1000 }, "no-pass"],
  [{ nowMs: NaN }, "unavailable"], [{ nowMs: 999 }, "before-aos"],
  [{ nowMs: 2000 }, "after-los"], [{ nowMs: 3000 }, "after-los"],
  [{ elevationDeg: null }, "unavailable"], [{ elevationDeg: NaN }, "unavailable"],
  [{ elevationDeg: 4.9 }, "below-mask"]
]) {
  const result = pure.evaluateTelemetryPassWindow({ ...base, ...change });
  assert.equal(result.allowed, false);
  assert.equal(result.state, state);
}
assert.equal(pure.evaluateTelemetryPassWindow({ ...base, nowMs: 1000, elevationDeg: 5 }).allowed, true);
assert.equal(pure.evaluateTelemetryPassWindow({ ...base, nowMs: 1999 }).allowed, true);
assert.equal(pure.evaluateTelemetryPassWindow({ ...base, elevationDeg: 5 - 1e-8 }).allowed, true, "Allow SGP4 crossing roundoff only");

let simulationTime = 500;
let connected = true;
let elevation = 30;
let resets = 0;
let clears = 0;
const waiting = element();
const gate = load({
  Date, Number, AOS_LOS_ELEVATION_THRESHOLD_DEG: 5,
  isReceiverConnected: () => connected,
  selectedPassIndex: 0, orbitMapState: { satrec: {} },
  currentPass: { aosDate: new Date(1000), losDate: new Date(2000) },
  currentTle: { line1: "tle1", line2: "tle2" },
  getOrbitMapDisplayDate: () => new Date(simulationTime),
  getGroundStationSetting: () => ({}),
  getLookAnglesFromTle: (_record, date) => {
    assert.equal(date.getTime(), simulationTime, "Use the upper panel's simulation clock, not Date.now()");
    return { elDeg: elevation };
  },
  clearTelemetryReceiveDisplays: () => { clears++; },
  telemetryGateWasAllowed: null, telemetryGatePassKey: null,
  packetUi: { logList: { querySelector: () => waiting } }, packetLogHistory: [],
  readRssiButton: { disabled: false }, xbeeTransparentSession: {},
  rssiReadStatus: element(), isXbeeApiMode: () => false, xbeePort: null,
  setRssiReadStatus: () => {},
  activePassResetKey: null, resetRxCommandCount: () => { resets++; }
}, ["evaluateTelemetryPassWindow", "getCurrentSatelliteElevationDegForTelemetryGate", "getTelemetryReceiveGateState", "isTelemetryDisplayAllowed", "updatePassBasedRxReset", "updateTelemetryReceiveGate"]);
assert.equal(gate.updateTelemetryReceiveGate(), false);
assert.equal(gate.getTelemetryReceiveGateState().state, "before-aos");
const initialClears = clears;
gate.updateTelemetryReceiveGate();
assert.equal(clears, initialClears, "Do not clear continuously while the same gate stays closed");
simulationTime = 1500;
assert.equal(gate.updateTelemetryReceiveGate(), true);
assert.equal(gate.getTelemetryReceiveGateState().state, "observing");
assert.equal(resets, 1);
simulationTime = 2000;
assert.equal(gate.updateTelemetryReceiveGate(), false);
assert.equal(clears, initialClears + 1);
assert.equal(gate.getTelemetryReceiveGateState().state, "after-los");
simulationTime = 1500;
gate.updateTelemetryReceiveGate();
gate.currentTle.line1 = "different satellite";
gate.updateTelemetryReceiveGate();
assert.equal(clears, initialClears + 2, "Switching a TLE/pass clears old visible data even if both windows are active");
gate.selectedPassIndex = -1;
assert.equal(gate.updateTelemetryReceiveGate(), false);
assert.equal(gate.getTelemetryReceiveGateState().state, "no-pass");
gate.selectedPassIndex = 0;
elevation = 4;
assert.equal(gate.getTelemetryReceiveGateState().state, "below-mask");
connected = false;
assert.equal(gate.getTelemetryReceiveGateState().state, "disconnected");

let imageResets = 0;
const fields = Object.fromEntries(["tmModeValue", "tmVoltageValue", "tmTempValue", "tmV5Value", "tmV3v3Value", "tmSapValue", "tmIsolValue", "tmIbusValue", "tmIchgValue", "tmAccXValue", "tmAccYValue", "tmAccZValue", "tmGyroXValue", "tmGyroYValue", "tmGyroZValue", "tmMagXValue", "tmMagYValue", "tmMagZValue", "header", "lastTime"].map(key => [key, element()]));
const clear = load({
  rssiValueEl: element(), rssiHistory: [{ rssi: -60 }], packetUi: { ...fields, logList: {} },
  telemetryHistory: [{}], packetLogHistory: [{}], packetByteBuffer: [0x7e],
  serialTextBuffer: "TEMP=9", serialHexTextBuffer: "7E 01", commandAckByteTextBuffer: "MISSION_",
  telemetryTextDecoder: new TextDecoder(), backendTelemetryState: { temperatureC: 90 }, currentTelemetryModeDisplay: {},
  applyTelemetryDataWarning: () => {},
  imageStreamReceiver: { reset: () => { imageResets++; } }, pendingImageReceiverChunks: [new Uint8Array([1])],
  pendingImageReceiverBytes: 1, xbeeImagePendingUntil: 9999,
  clearReceivedImageUrl: () => {}, imageReceivePreview: element(), imageDownloadLink: element(),
  imageReceiveProgressBar: element(), imageReceiveProgressText: element(), setImageStatus: () => {},
  drawTelemetryGraphs: () => {}, drawRssiGraph: () => {},
}, ["setTelemetryText", "clearTelemetryReceiveDisplays"]);
clear.clearTelemetryReceiveDisplays();
for (const key of ["telemetryHistory", "packetLogHistory", "packetByteBuffer"]) assert.equal(clear[key].length, 0);
assert.equal(clear.pendingImageReceiverChunks.length, 1, "Pass changes must not drop queued photo bytes");
assert.equal(clear.rssiHistory.length, 1, "Closing an HK window must not clear ground-receiver RSSI");
for (const key of ["serialTextBuffer", "serialHexTextBuffer", "commandAckByteTextBuffer"]) assert.equal(clear[key], "");
assert.equal(fields.tmModeValue.textContent, "--");
assert.equal(fields.tmVoltageValue.textContent, "-- V");
assert.equal(fields.lastTime.textContent, "--");
assert.equal(clear.backendTelemetryState.temperatureC, null);
assert.equal(clear.imageReceivePreview.hidden, false, "Keep the last received photo visible");
assert.equal(clear.imageDownloadLink.hidden, false);
assert.equal(imageResets, 0, "Closing an HK window must not reset photo reception");

let allowed = false;
const textRows = [];
const text = load({
  TextEncoder, serialTextBuffer: "", serialHexTextBuffer: "",
  updateTelemetryReceiveGate: () => allowed, isTelemetryDisplayAllowed: () => allowed,
  handleReceiverRssiText: () => {},
  updateRssiFromReceivedText: () => {}, feedHexTextPacketStream: () => {},
  updateRawSerialHexDisplay: () => {}, bytesToHex: () => "",
  updateTelemetryDisplayFromBackendText: line => textRows.push(line),
  updateCommandAckLog: () => {}, incrementRxCommandCount: () => {}
}, ["handleReceivedSerialText"]);
text.handleReceivedSerialText("TEMP=999.");
allowed = true;
text.handleReceivedSerialText("1\r\n");
assert.deepEqual(textRows, ["1"], "Do not stitch a pre-AOS tail onto an in-window record");
text.handleReceivedSerialText("TEMP=23.4\r\n");
text.handleReceivedSerialText("TEMP=999");
allowed = false;
text.handleReceivedSerialText(".9\r\n");
assert.deepEqual(textRows, ["1", "TEMP=23.4"]);
assert.equal(text.serialTextBuffer, "");

const packets = [];
const bytes = load({
  Array, TELEMETRY_PACKET: { header: 0x7e }, packetByteBuffer: [],
  updateTelemetryReceiveGate: () => allowed, isTelemetryDisplayAllowed: () => allowed,
  updateCommandAckLogFromBytes: () => {}, isTelemetryPacketType: t => t === 0x10,
  isTelemetryPayloadLength: l => l === 23,
  parseTelemetryPacket: rawBytes => ({ rawBytes, checksumOk: true }),
  markCommandAckFromTelemetryPacket: () => {}, updatePacketDisplay: packet => packets.push(Array.from(packet.rawBytes)),
  addPacketLog: () => {}, bytesToHex: () => ""
}, ["handleReceivedSerialBytes"]);
const packet = new Uint8Array(30); packet.set([0x7e, 1, 0x10, 0, 1, 23]);
bytes.handleReceivedSerialBytes(packet.slice(0, 10));
allowed = true;
bytes.handleReceivedSerialBytes(packet.slice(10));
assert.equal(packets.length, 0);
bytes.handleReceivedSerialBytes(packet);
assert.equal(packets.length, 1);
bytes.handleReceivedSerialBytes(packet.slice(0, 10));
allowed = false;
bytes.handleReceivedSerialBytes(packet.slice(10));
assert.equal(bytes.packetByteBuffer.length, 0);
allowed = true;
bytes.handleReceivedSerialBytes(packet);
assert.equal(packets.length, 2, "Only full in-window packets are decoded");

const payloads = [];
const radio = load({
  updateTelemetryReceiveGate: () => allowed,
  imageStreamReceiver: { push: b => payloads.push(...b) },
  pendingImageReceiverBytes: 0, pendingImageReceiverChunks: [], MAX_PENDING_IMAGE_RECEIVER_BYTES: 100
}, ["handleReceivedRadioPayload"]);
allowed = false;
radio.handleReceivedRadioPayload(packet);
assert.equal(payloads.length, packet.length, "Route bytes to the image demultiplexer even outside the HK window");
allowed = true;
radio.handleReceivedRadioPayload(packet);
assert.deepEqual(payloads, [...packet, ...packet]);

assert.match(html, /<option value="transparent">Basic mode \(AP=0\)<\/option>/);
assert.match(html, /<option value="api">Extension mode \(AP=1\)<\/option>/);
assert.doesNotMatch(html, /Real RSSI/);
assert.doesNotMatch(html, /telemetry-gate-status/, "Do not display a telemetry pass-status banner; retain the receive gate itself");
assert.match(html, /\.tm-value-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/, "Values must still fill the panel without the banner's intrinsic width");
assert.match(html, /isBusy: \(\) => imageStreamReceiver/);
assert.doesNotMatch(html, /isBusy: \(\) => !isTelemetryDisplayAllowed/);
assert.doesNotMatch(html, /id="transparent-rssi-auto"|id="read-rssi-button"/);
assert.doesNotMatch(html, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, "The interface must be English-only");
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (!match[0].includes('type="importmap"')) new vm.Script(match[1]);
}
console.log("HEPTA-SAT reserved pass clock, AOS/LOS/mask, buffer isolation, clearing and mode-label tests passed");
