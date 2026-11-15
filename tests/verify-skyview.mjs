import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Exercise the actual inline production functions, not a second projection.
const html = fs.readFileSync(new URL("../public/ground-station.html", import.meta.url), "utf8");
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function: ${name}`);
  const body = html.indexOf("{", start);
  let depth = 1;
  let end = body + 1;
  while (depth && end < html.length) {
    if (html[end] === "{") depth++;
    if (html[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0, `Unbalanced function: ${name}`);
  return html.slice(start, end);
}

const elements = new Map([
  ["skyview-aos-label", {}], ["skyview-los-label", {}], ["skyview-mask-label", {}]
]);
const attributes = {};
const context = vm.createContext({
  Math, Date, Number,
  CANVAS_THEME: {
    plotBg: "plot", grid: "grid", gridStrong: "strong",
    text: "text", textMuted: "muted", labelBg: "label"
  },
  AOS_LOS_ELEVATION_THRESHOLD_DEG: 5,
  currentPass: { aosDate: new Date(10000), losDate: new Date(90000) },
  document: { getElementById: id => elements.get(id) || null },
  azGraphCanvas: { setAttribute: (name, value) => { attributes[name] = value; } },
  getAzelGraphTimeWindow: () => ({ startMs: 0, endMs: 100000 }),
  getLookAnglesFromTle: (_satrec, date) => ({ azDeg: date.getTime() / 1000, elDeg: 5, rangeKm: 800 })
});
vm.runInContext([
  "deg2rad", "normalizeDeg", "clamp", "pad2", "formatJstTimeAxis",
  "formatJstDateTimeCompact", "getSkyviewPoint", "updateSkyviewLegend",
  "drawSkyviewPlot", "buildGraphSeriesData"
].map(extractFunction).join("\n"), context);

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const center = { x: 150, y: 150 };
for (const [az, dx, dy] of [[0, 0, -1], [90, 1, 0], [180, 0, 1], [270, -1, 0]]) {
  const horizon = context.getSkyviewPoint(az, 0, center.x, center.y, 90);
  close(horizon.x, center.x + 90 * dx);
  close(horizon.y, center.y + 90 * dy);
  for (const [el, radial] of [[30, 60], [60, 30], [90, 0]]) {
    const point = context.getSkyviewPoint(az, el, center.x, center.y, 90);
    close(point.radial, radial);
    close(point.x, center.x + radial * dx);
    close(point.y, center.y + radial * dy);
  }
}
close(context.getSkyviewPoint(360, 30, 0, 0, 90).y, -60);
close(context.getSkyviewPoint(-90, 30, 0, 0, 90).x, -60);
for (const [az, el] of [[0, -1], [0, 91], [NaN, 30], [0, NaN], [Infinity, 0]]) {
  assert.equal(context.getSkyviewPoint(az, el, 0, 0, 90), null);
}
assert.ok(context.getSkyviewPoint(0, -1e-9, 0, 0, 90), "Allow root-finder roundoff at the horizon");

const generated = context.buildGraphSeriesData({}, {}, new Date(50000));
assert.equal(generated.points.length, 151);
assert.equal(generated.points[0].timeMs, 0);
assert.equal(generated.points.at(-1).timeMs, 100000);
assert.deepEqual(Array.from(generated.events, e => [e.label, e.timeMs, e.az, e.el]), [
  ["AOS", 10000, 10, 5], ["LOS", 90000, 90, 5]
]);
context.currentPass.aosDate = new Date(-10000);
assert.equal(context.buildGraphSeriesData({}, {}, new Date(0)).events.length, 1, "No stale pass event outside this window");
assert.equal(context.buildGraphSeriesData(null, {}, new Date(0)).events.length, 0);
context.currentPass.aosDate = new Date(10000);

function recordingCanvas() {
  return {
    arcs: [], lines: [], texts: [], path: [],
    save() {}, restore() {}, fillRect() {}, fill() {}, setLineDash() {},
    beginPath() { this.path = []; },
    arc(...args) { this.arcs.push(args); },
    moveTo(x, y) { this.path.push(["M", x, y]); },
    lineTo(x, y) { this.path.push(["L", x, y]); },
    stroke() { this.lines.push({ color: this.strokeStyle, path: this.path.slice() }); },
    measureText(text) { return { width: text.length * 6 }; },
    fillText(text, x, y) { this.texts.push({ text, x, y }); }
  };
}
const series = {
  startMs: 0, endMs: 100, nowMs: 50,
  points: [
    { az: 180, el: 0, visible: false }, { az: 150, el: 30, visible: true },
    { az: 90, el: -3, visible: false },
    { az: 45, el: 30, visible: true }, { az: 0, el: 0, visible: false }
  ],
  events: [{ label: "AOS", timeMs: 10, az: 180, el: 5 }, { label: "LOS", timeMs: 90, az: 0, el: 5 }]
};
function draw(nowMs, look = { azDeg: 90, elDeg: 30, rangeKm: 800 }) {
  const canvas = recordingCanvas();
  context.drawSkyviewPlot(canvas, 300, 300, { left: 0, top: 0, width: 300, height: 300 }, { ...series, nowMs }, look);
  return canvas;
}
const canvas = draw(50);
assert.equal(canvas.lines.filter(line => ["#e6523f", "muted"].includes(line.color) && line.path.length).length, 2, "Break track at below-horizon points");
assert.equal(canvas.texts.filter(t => t.text === "AOS" || t.text === "LOS").length, 2);
const marker = result => result.arcs.find(arc => arc[2] === 4.5);
close(marker(canvas)[0], 230); // radius 120, El 30° -> radius 80; Az 90° -> east.
close(marker(canvas)[1], 150);
assert.deepEqual(marker(draw(10)), marker(draw(90, { azDeg: 90, elDeg: 30, rangeKm: 4000 })), "Time/range must not change skyplot radius");
assert.equal(marker(draw(50, { azDeg: 0, elDeg: -1 })), undefined, "Hide current marker below the horizon");
assert.equal(marker(draw(101)), undefined, "Do not mix another pass into the selected track");
assert.ok(canvas.texts.some(t => t.text === "N 0°"));
assert.ok(canvas.texts.some(t => t.text === "E 90°"));
for (const text of canvas.texts) {
  assert.ok(Number.isFinite(text.x) && Number.isFinite(text.y));
  assert.ok(text.x >= 0 && text.x <= 300 && text.y >= 0 && text.y <= 300);
}

const crossing = new Date("2026-11-12T15:08:23Z").getTime();
context.updateSkyviewLegend({ events: [
  { label: "AOS", timeMs: crossing }, { label: "LOS", timeMs: crossing + 60000 }
] }, { azDeg: 0, elDeg: -2 });
assert.equal(elements.get("skyview-aos-label").textContent, "AOS 00:08:23 JST");
assert.equal(elements.get("skyview-los-label").textContent, "LOS 00:09:23 JST");
assert.match(elements.get("skyview-aos-label").title, /26\/11\/13/);
assert.match(elements.get("skyview-mask-label").textContent, /El 5°/);
assert.match(attributes["aria-label"], /below horizon/);
context.updateSkyviewLegend({ events: [] }, null);
assert.equal(elements.get("skyview-aos-label").textContent, "AOS --:--:--");
assert.equal(elements.get("skyview-los-label").textContent, "LOS --:--:--");

console.log("HEPTA-SAT skyview projection, horizon, pass events, and JST tests passed");
