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
const missionFields = {
  accX: "tmAccXValue", accY: "tmAccYValue", accZ: "tmAccZValue",
  gyroX: "tmGyroXValue", gyroY: "tmGyroYValue", gyroZ: "tmGyroZValue",
  magX: "tmMagXValue", magY: "tmMagYValue", magZ: "tmMagZValue"
};
const hkFields = ["tmModeValue", "tmVoltageValue", "tmVoltageRaw", "tmTempValue", "tmTempRaw", "tmV5Value", "tmV3v3Value", "tmSapValue", "tmIsolValue", "tmIbusValue", "tmIchgValue"];
const packetUi = Object.fromEntries([...hkFields, ...Object.values(missionFields)].map(key => [key, {
  textContent: "--", className: "", title: "", classList: { toggle() {} }, setAttribute() {}
}]));
let allowed = true;
const context = vm.createContext({
  packetUi, confirmedTelemetryMode: null, missionTelemetryEnabled: null,
  currentTelemetryModeDisplay: { text: "Standby", className: "normal" },
  backendTelemetryState: {}, telemetryHistory: [],
  isTelemetryDisplayAllowed: () => allowed, getTelemetryHistoryTimeMs: () => 1234,
  drawTelemetryGraphs() {}, isTelemetryPacketType: type => [0x10, 0x11, 0x12].includes(type),
  TELEMETRY_PACKET: { typeHk: 0x10, basicPayloadLength: 5, missionPayloadLength: 23, extendedPayloadLength: 35 },
  rssiHistory: [{ time: 123, rssi: -45 }], imageStreamReceiver: { mode: "image" }
});
const definition = html.match(/const MISSION_TELEMETRY_FIELDS = \{[\s\S]*?\n    \};/);
assert.ok(definition);
vm.runInContext(definition[0], context);
vm.runInContext([
  "setTelemetryText", "setMissionTelemetryEnabled", "getPowerModeFromVoltage", "updateTelemetryStatusDisplays",
  "updateTelemetryModeFromCommandAck", "updateTelemetryDisplayFromObject", "updateTelemetryDisplayFromBackendText",
  "byteToHex", "readInt16BE", "decodeMode", "decodePacketTypeMode", "decodeHkPayload",
  "applyTelemetryDataWarning", "updateDecodedTelemetryDisplay"
].map(extract).join("\n"), context);

const hk = "TEMP=23.40,BUS=3.100,V5=5.001,V3V3=3.301,SAP=4.120,ISOL=0.104,IBUS=0.217,ICHG=0.031";
const imu = "AX=0.10,AY=-0.20,AZ=-9.80,GX=0.30,GY=-0.40,GZ=0.50,MX=21.00,MY=-4.00,MZ=38.00";
context.updateTelemetryModeFromCommandAck("ON");
context.updateTelemetryDisplayFromBackendText(hk);
context.updateTelemetryDisplayFromBackendText(imu);
assert.equal(packetUi.tmModeValue.textContent, "Mission", "Do not replace a confirmed mode with a low-voltage guess");
assert.equal(packetUi.tmAccZValue.textContent, "-9.80 m/s2");
assert.ok(context.telemetryHistory.some(p => p.accZ === -9.8));

context.updateTelemetryModeFromCommandAck("OFF");
assert.equal(packetUi.tmModeValue.textContent, "Standby");
for (const [key, field] of Object.entries(missionFields)) {
  assert.equal(packetUi[field].textContent, "—");
  assert.equal(context.backendTelemetryState[key], null);
  assert.ok(context.telemetryHistory.every(p => p[key] === undefined));
}
assert.equal(packetUi.tmVoltageValue.textContent, "3.10 V");
assert.ok(context.telemetryHistory.some(p => p.voltageV === 3.1), "Keep HK history");
assert.equal(context.rssiHistory.length, 1);
assert.equal(context.imageStreamReceiver.mode, "image");
context.updateTelemetryDisplayFromBackendText("TEMP=24.10,BUS=3.200,V5=5.020");
assert.equal(packetUi.tmTempValue.textContent, "24.1 °C");
assert.equal(packetUi.tmVoltageValue.textContent, "3.20 V");
assert.equal(packetUi.tmModeValue.textContent, "Standby");
assert.equal(context.updateTelemetryDisplayFromBackendText(imu), false, "Ignore stale IMU lines in Standby");
context.updateTelemetryDisplayFromObject({ voltageV: 3.21, accZ: -999 });
assert.equal(packetUi.tmAccZValue.textContent, "—", "Backend objects cannot reintroduce held IMU values");
assert.ok(context.telemetryHistory.every(p => p.accZ === undefined));

context.updateTelemetryModeFromCommandAck("ON");
assert.equal(packetUi.tmAccZValue.textContent, "—", "Mission must wait for a fresh IMU reading");
context.updateTelemetryDisplayFromBackendText(hk);
assert.equal(packetUi.tmAccZValue.textContent, "—");
context.updateTelemetryDisplayFromBackendText("AZ=-9.50");
assert.equal(packetUi.tmAccZValue.textContent, "-9.50 m/s2");
assert.equal(packetUi.tmAccXValue.textContent, "—", "Do not resurrect other cached axes");

const payload = new Uint8Array(23);
const data = new DataView(payload.buffer);
data.setUint16(1, 3200); data.setInt16(3, 241); data.setInt16(9, -980);
context.updateDecodedTelemetryDisplay({ checksumOk: true, packetType: 0x10, payload });
assert.equal(packetUi.tmModeValue.textContent, "Standby");
assert.equal(packetUi.tmAccZValue.textContent, "—", "Binary Standby packets also suppress mission values");
assert.equal(packetUi.tmVoltageValue.textContent, "3.20 V");
context.updateDecodedTelemetryDisplay({ checksumOk: true, packetType: 0x11, payload });
assert.equal(packetUi.tmAccZValue.textContent, "-9.80 m/s2");
const count = context.telemetryHistory.length;
allowed = false;
context.updateTelemetryDisplayFromBackendText("TEMP=99.0");
assert.equal(context.telemetryHistory.length, count, "Keep the reserved-pass gate intact");
console.log("HEPTA-SAT Standby dashes, fresh Mission values, HK continuity and mode priority tests passed");
