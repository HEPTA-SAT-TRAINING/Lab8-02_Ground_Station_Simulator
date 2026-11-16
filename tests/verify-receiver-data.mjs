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
let wallTime = 1000000;
const receiver = load({
  Date: { now: () => wallTime }, rssiValueEl: { textContent: "--" }, rssiHistory: [], rssiGraphStartMs: null,
  drawRssiGraph: () => {},
  updateTelemetryReceiveGate: () => { throw new Error("Receiver RSSI must not consult the HK pass gate"); },
  getTelemetryHistoryTimeMs: () => { throw new Error("RSSI must not use the orbit simulation clock"); }
}, ["updateRssiDisplay", "getRssiGraphTimeRange", "normalizeRssiDbm"]);
receiver.updateRssiDisplay(-64);
assert.equal(receiver.rssiValueEl.textContent, "-64");
assert.equal(receiver.rssiHistory[0].time, wallTime);
wallTime += 2000;
receiver.updateRssiDisplay(-70);
assert.equal(receiver.rssiHistory.length, 2);
assert.equal(receiver.rssiHistory[1].time, wallTime);
const range = receiver.getRssiGraphTimeRange();
assert.equal(range.startMs, 1000000, "The first sample anchors the left edge");
assert.equal(range.endMs, 1180000);
assert.equal((wallTime - range.startMs) / range.durationMs, 2000 / 180000, "New samples advance left to right instead of being pinned to the right");
assert.equal(range.historyBounded, true);
assert.equal(range.passBounded, undefined);
wallTime = 1240000;
const rolling = receiver.getRssiGraphTimeRange();
assert.equal(rolling.startMs, wallTime - 180000, "Scroll only after the initial window is full");
assert.equal(rolling.endMs, wallTime);
for (const value of [null, undefined, "", "  "]) assert.equal(receiver.normalizeRssiDbm(value), null);

const textValues = [];
const text = load({
  rssiSerialTextBuffer: "", USE_SIMULATED_RSSI: false,
  updateRssiDisplay: value => textValues.push(value)
}, ["normalizeRssiDbm", "updateRssiFromReceivedText", "handleReceiverRssiText"]);
text.handleReceiverRssiText("RSS");
assert.equal(textValues.length, 0);
text.handleReceiverRssiText("I=-66\r\nDB=4");
assert.deepEqual(textValues, [-66]);
text.handleReceiverRssiText("0\r\n");
assert.deepEqual(textValues, [-66, -64]);

function field() {
  return { textContent: "", title: "", warning: false, attributes: {},
    classList: { toggle(name, enabled) { this.owner.warning = enabled; } },
    setAttribute(name, value) { this.attributes[name] = value; } };
}
const names = ["tmModeValue", "tmVoltageValue", "tmVoltageRaw", "tmTempValue", "tmTempRaw", "tmV5Value", "tmV3v3Value", "tmSapValue", "tmIsolValue", "tmIbusValue", "tmIchgValue", "tmAccXValue", "tmAccYValue", "tmAccZValue", "tmGyroXValue", "tmGyroYValue", "tmGyroZValue", "tmMagXValue", "tmMagYValue", "tmMagZValue"];
const ui = Object.fromEntries(names.map(name => [name, field()]));
for (const f of Object.values(ui)) f.classList.owner = f;
const context = load({
  TELEMETRY_PACKET: { typeHk: 0x10, basicPayloadLength: 5, missionPayloadLength: 23, extendedPayloadLength: 35 },
  packetUi: ui,
  isTelemetryDisplayAllowed: () => true, isTelemetryPacketType: type => type === 0x10 || type === 0x11,
  updateTelemetryStatusDisplays: () => {}, getTelemetryHistoryTimeMs: () => 123,
  telemetryHistory: [], drawTelemetryGraphs: () => {}
}, ["byteToHex", "readInt16BE", "decodeMode", "decodePacketTypeMode", "decodeHkPayload", "setTelemetryText", "applyTelemetryDataWarning", "updateDecodedTelemetryDisplay"]);

// Exact scales used by the user's supplied HEPTA_Flightware.ino builder.
const payload = new Uint8Array(23);
const data = new DataView(payload.buffer);
payload[0] = 1;
data.setUint16(1, 3780); // mV, not an ADC count.
data.setInt16(3, 234); // 23.4°C in both schemas.
data.setInt16(5, 123);
data.setInt16(7, -234);
data.setInt16(9, 980);
data.setInt16(11, 123);
data.setInt16(13, -456);
data.setInt16(15, 789);
data.setInt16(17, 210);
data.setInt16(19, -400);
data.setInt16(21, 380);
const decoded = context.decodeHkPayload(payload, 0x11);
assert.equal(decoded.voltageV, 3.78);
assert.equal(decoded.temperatureC, 23.4);
assert.equal(decoded.accX, 1.23);
assert.equal(decoded.accY, -2.34);
assert.equal(decoded.accZ, 9.8);
assert.equal(decoded.gyroX, 12.3);
assert.equal(decoded.gyroY, -45.6);
assert.equal(decoded.magX, 21);
assert.equal(decoded.magY, -40);
context.updateDecodedTelemetryDisplay({ checksumOk: true, packetType: 0x11, payload });
assert.equal(ui.tmVoltageValue.textContent, "3.78 V");
assert.equal(ui.tmAccZValue.textContent, "9.80 m/s2");
assert.equal(ui.tmGyroXValue.textContent, "12.3 deg/s");
assert.equal(ui.tmMagXValue.textContent, "21.0 uT");
assert.match(ui.tmVoltageRaw.textContent, /3780 mV/);
assert.equal(ui.tmTempValue.warning, false);
const course = context.decodeHkPayload(payload, 0x11, "course-adc");
assert.equal(course.voltageV, 3780 / 4096 * 3.3 * 1.431);
assert.equal(course.accZ, 980 / 512 * 9.8);
assert.equal(course.gyroX, 123 * 125 / 2048);
assert.equal(course.magX, 210);
assert.throws(() => context.decodeHkPayload(payload, 0x11, "guess"), /Unknown binary HK/);

// The screenshot's 125.6°C is already generated at ADC=0 on the OBC.
// Preserve that report and flag its unverified input, never invent 25°C.
const zeroAdcTemperature = (((0 - (2.5 + 0.001 * 110)) / (-68000 * 0.001 / 1000) + 110) - 100) / (0.003851 * 100);
assert.equal(Math.round(zeroAdcTemperature * 10), 1256);
const zeroInput = new Uint8Array(23);
new DataView(zeroInput.buffer).setInt16(3, 1256);
context.updateDecodedTelemetryDisplay({ checksumOk: true, packetType: 0x10, payload: zeroInput });
assert.equal(ui.tmVoltageValue.textContent, "0.00 V");
assert.equal(ui.tmTempValue.textContent, "125.6 °C");
assert.equal(ui.tmTempValue.warning, true);
assert.match(ui.tmTempValue.title, /zero ADC inputs/);
assert.match(ui.tmTempValue.attributes["aria-label"], /not validated/);

assert.doesNotMatch(html, /id="transparent-rssi-auto"|id="read-rssi-button"/);
assert.doesNotMatch(html, /id="hk-format-select"|Binary HK format|Flightware physical units|Course ADC format/);
assert.doesNotMatch(html, /Use the p command to capture a photo/);
assert.match(html, /id="image-receive-status"><\/div>/, "Keep the dynamic photo status, without an initial command hint");
assert.match(html, /\.image-receive-status:empty\s*\{\s*display: none/, "Do not leave an empty hint box");
assert.match(html, /class="visually-hidden" id="rssi-read-status"/);
assert.doesNotMatch(extract("clearTelemetryReceiveDisplays"), /rssiHistory\s*=|rssiValueEl/);
assert.doesNotMatch(extract("updateTelemetryReceiveGate"), /rssiReadStatus|seenPayload/);
assert.doesNotMatch(extract("handleXbeeApiSerialBytes"), /if \(!updateTelemetryReceiveGate\(\)\) continue/);
assert.doesNotMatch(html, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
const capture = load({
  xbeeImagePendingUntil: 5000, imageStreamReceiver: { mode: "telemetry" },
  imageReceiveProgressText: { textContent: "Preparing capture and transfer" },
  imageReceiveProgressBar: { hidden: false }, setImageStatus: (message, error) => { capture.message = message; capture.error = error; }
}, ["updatePhotoCaptureTimeout"]);
capture.updatePhotoCaptureTimeout(4999);
assert.equal(capture.xbeeImagePendingUntil, 5000);
capture.updatePhotoCaptureTimeout(5000);
assert.equal(capture.xbeeImagePendingUntil, 0);
assert.equal(capture.imageReceiveProgressBar.hidden, true);
assert.equal(capture.imageReceiveProgressText.textContent, "No photo data received");
assert.match(capture.message, /no IMG_BEGIN/);
assert.equal(capture.error, true);
capture.xbeeImagePendingUntil = 5000;
capture.imageStreamReceiver.mode = "image";
capture.updatePhotoCaptureTimeout(6000);
assert.equal(capture.xbeeImagePendingUntil, 5000, "Do not replace an active image's own packet timeout");
assert.match(html, /\.image-receive-preview img\[hidden\]\s*\{\s*display: none/);
console.log("HEPTA-SAT independent receiver RSSI, compact English UI, Flightware/course scales and zero-input warning tests passed");
