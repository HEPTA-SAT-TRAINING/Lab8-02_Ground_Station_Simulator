import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TransparentRssiSession } from "../public/xbee-transparent.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

class Clock {
  time = 0;
  sequence = 0;
  tasks = new Map();
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = ++this.sequence;
    this.tasks.set(id, { callback, at: this.time + Math.max(0, delay) });
    return id;
  };
  clearTimer = id => this.tasks.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    await settle();
    for (let count = 0; count < 10000; count++) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await settle();
      assert.ok(count < 9999, "Timer loop did not terminate");
    }
    this.time = end;
    await settle();
  }
}

function telemetry(sequence = 1) {
  const bytes = new Uint8Array(30);
  bytes.set([0x7e, 1, 0x10, 0, sequence, 23]);
  // Deliberately include exact AT-looking strings inside a binary payload.
  bytes.set(encoder.encode("OK\r40\r"), 7);
  bytes[29] = bytes.slice(1, -1).reduce((sum, b) => (sum + b) & 0xff, 0);
  return bytes;
}

function fixture(options = {}) {
  const clock = new Clock();
  const writes = [], payloads = [], values = [], statuses = [];
  let radioInCommand = false;
  let lastDin = -1000;
  let busy = false;
  const afterExit = options.afterExit || new Uint8Array(0);
  let session;
  function reply(text, tail = new Uint8Array(0)) {
    const bytes = encoder.encode(`${text}\r`);
    clock.setTimer(() => session.push(bytes.slice(0, 1)), 1);
    clock.setTimer(() => session.push(bytes.slice(1, -1)), 2);
    clock.setTimer(() => session.push(new Uint8Array([...bytes.slice(-1), ...tail])), 3);
  }
  async function write(bytes) {
    const text = decoder.decode(bytes);
    writes.push({ text, time: clock.now(), radioInCommand });
    const quietBefore = clock.now() - lastDin;
    lastDin = clock.now();
    if (options.writeError === text) throw new Error("USB write failed");
    if (text === "+++") {
      if (options.guardTelemetry) {
        clock.setTimer(() => session.push(options.guardTelemetry.slice(0, 11)), 1);
        clock.setTimer(() => session.push(options.guardTelemetry.slice(11)), 2);
      }
      if (options.rejectEntry) return;
      assert.ok(quietBefore >= 20, "Missing pre-escape guard");
      clock.setTimer(() => {
        assert.equal(lastDin, writes.findLast(w => w.text === "+++").time, "Write interrupted post-escape guard");
        radioInCommand = true;
        if (!options.dropEntryAck) reply("OK");
      }, 10);
      return;
    }
    if (text.startsWith("AT")) {
      assert.ok(radioInCommand, `AT command leaked into RF payload: ${text}`);
      assert.ok(clock.now() - writes.findLast(w => w.text === "+++").time >= 20, "Post-escape guard too short");
      if (text === "ATAP\r") reply(options.ap || "0");
      else if (text === "ATCT\r") reply(options.ct || "64");
      else if (text === "ATDB\r") reply(options.db ?? "40");
      else if (text === "ATCN\r") {
        radioInCommand = false;
        if (!options.dropExitAck) reply("OK", afterExit);
      } else assert.fail(`Unexpected/setting-changing command: ${text}`);
    } else {
      assert.ok(!radioInCommand, "User payload sent while the local radio was in AT mode");
    }
  }
  session = new TransparentRssiSession({
    write, onPayload: b => payloads.push(...b), onRssi: value => values.push(value),
    onStatus: status => statuses.push(status), isBusy: () => busy,
    guardMs: 20, replyTimeoutMs: 20, intervalMs: 100,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    recoveryUntil: options.recoveryUntil || 0,
  });
  return { session, clock, writes, payloads, values, statuses, setBusy: value => { busy = value; } };
}

const normal = fixture({ guardTelemetry: telemetry(1), afterExit: telemetry(2) });
normal.session.push(telemetry(0));
const firstPoll = normal.session.poll();
const samePoll = normal.session.poll();
assert.equal(firstPoll, samePoll, "Do not overlap RSSI transactions");
await normal.clock.advance(100);
assert.equal(await firstPoll, -64);
assert.deepEqual(normal.values, [-64]);
assert.deepEqual(normal.writes.map(w => w.text), ["+++", "ATAP\r", "ATCT\r", "ATDB\r", "ATCN\r"]);
assert.deepEqual(normal.payloads, [...telemetry(0), ...telemetry(1), ...telemetry(2)], "Control responses must not corrupt/suppress telemetry, including embedded OK/hex + CR");
assert.equal(normal.session.mode, "data");
assert.equal(normal.session.commandTimeoutMs, 10000);
await normal.session.close();
assert.equal(normal.clock.tasks.size, 0);

const queued = fixture();
const query = queued.session.poll();
await settle();
const command = queued.session.writePayload(encoder.encode("a"));
await queued.clock.advance(100);
await Promise.all([query, command]);
assert.equal(queued.writes.at(-1).text, "a", "User command must wait for ATCN acknowledgement");
assert.ok(queued.writes.at(-1).time > queued.writes.find(w => w.text === "ATCN\r").time);
await queued.session.close();

const zero = fixture({ db: "0" });
const zeroRead = zero.session.poll();
await zero.clock.advance(100);
assert.equal(await zeroRead, null);
assert.deepEqual(zero.values, [null], "DB=0 clears the value rather than fabricating a 0 dBm sample");
await zero.session.close();

const lowercase = fixture({ db: "4a" });
const lowerRead = lowercase.session.poll();
await lowercase.clock.advance(100);
assert.equal(await lowerRead, -74);
await lowercase.session.close();

for (const options of [{ db: "ERROR" }, { db: "GG" }, { ap: "1" }, { ct: "FFFF" }]) {
  const f = fixture(options);
  const failed = assert.rejects(f.session.poll());
  await f.clock.advance(200);
  await failed;
  assert.deepEqual(f.values, []);
  assert.equal(f.writes.at(-1).text, "ATCN\r", "Confirmed AT sessions must exit even on bad DB/AP/CT replies");
  assert.equal(f.session.mode, "data");
  assert.ok(f.statuses.some(s => s.state === "error"));
  await f.session.close();
}

for (const options of [{ rejectEntry: true }, { dropEntryAck: true }]) {
  const f = fixture(options);
  f.session.setAuto(true);
  const failed = assert.rejects(f.session.poll());
  await f.clock.advance(100);
  await failed;
  assert.deepEqual(f.writes.map(w => w.text), ["+++"], "No ATDB/ATCN without a confirmed entry OK");
  assert.equal(f.session.mode, "uncertain");
  const held = f.session.writePayload(encoder.encode("b"));
  const heldFailure = assert.rejects(held, /closed/);
  await f.clock.advance(1000);
  assert.equal(f.writes.length, 1, "Hold outgoing data during an unconfirmed command-mode timeout");
  const until = f.session.recoveryUntil;
  assert.ok(until > f.clock.now());
  await f.session.close();
  await heldFailure;
  assert.equal(f.session.recoveryUntil, until, "Expose recovery deadline for reconnect safety");
  assert.equal(f.clock.tasks.size, 0, "Disconnect cancels auto polling and pending waits");
}

const exitLost = fixture({ dropExitAck: true });
const lostExit = assert.rejects(exitLost.session.poll());
await exitLost.clock.advance(100);
await lostExit;
assert.equal(exitLost.session.mode, "uncertain");
const heldCommand = exitLost.session.writePayload(encoder.encode("p"));
await exitLost.clock.advance(100);
assert.equal(exitLost.writes.at(-1).text, "ATCN\r");
await exitLost.clock.advance(11000);
await heldCommand;
assert.equal(exitLost.writes.at(-1).text, "p", "Resume only after the read-back CT timeout expires");
await exitLost.session.close();

const reconnect = fixture({ recoveryUntil: 1000 });
const reconnectCommand = reconnect.session.writePayload(encoder.encode("a"));
await reconnect.clock.advance(999);
assert.equal(reconnect.writes.length, 0);
await reconnect.clock.advance(1);
await reconnectCommand;
assert.equal(reconnect.writes.at(-1).text, "a");
await reconnect.session.close();

const photo = fixture();
photo.setBusy(true);
photo.session.setAuto(true);
photo.session.push(encoder.encode("IMG_BEGIN\n"));
await photo.clock.advance(200);
assert.equal(photo.writes.length, 0, "No auto AT probe while receiving a photo");
assert.equal(await photo.session.poll(), null, "Manual probes also defer to photos");
photo.setBusy(false);
await photo.clock.advance(1000);
assert.ok(photo.values.length > 0, "Auto querying resumes when the photo is complete");
await photo.session.close();

const automatic = fixture();
automatic.session.setAuto(true);
await automatic.clock.advance(300);
assert.equal(automatic.writes.length, 0, "Wait for RF data before automatic probing");
automatic.session.push(telemetry());
await automatic.clock.advance(1000);
assert.ok(automatic.values.length >= 1);
automatic.session.setAuto(false);
const count = automatic.writes.length;
await automatic.clock.advance(1000);
assert.equal(automatic.writes.length, count, "Auto off stops new probes");
automatic.session.push(encoder.encode("OK\r40\r"));
assert.deepEqual(automatic.payloads.slice(-6), [...encoder.encode("OK\r40\r")], "Do not strip AT-looking application text outside a query");
await automatic.session.close();

for (const stopAt of [5, 34, 44]) {
  const f = fixture();
  const pending = f.session.poll().catch(() => null);
  await f.clock.advance(stopAt);
  const closing = f.session.close();
  await f.clock.advance(200);
  await Promise.all([pending, closing]);
  assert.equal(f.session.active, false);
  if (stopAt === 34 || stopAt === 44) assert.equal(f.writes.at(-1).text, "ATCN\r");
  const n = f.writes.length;
  await f.clock.advance(1000);
  assert.equal(f.writes.length, n, "No stray query after disconnect");
}

const html = fs.readFileSync(new URL("../public/ground-station.html", import.meta.url), "utf8");
assert.match(html, /xbeeTransparentSession\.push\(value\)/);
assert.match(html, /await xbeeTransparentSession\.writePayload\(transmittedBytes\)/);
assert.match(html, /usbVendorId === 0x2e8a/);
assert.match(html, /await stopXbeeTransparentRssi\(\);\s*xbeeReadLoopActive = false/);
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (!match[0].includes('type="importmap"')) new vm.Script(match[1]);
}
console.log("HEPTA-SAT AP=0 RSSI guard, AT reply, telemetry, queue, recovery, photo, auto and disconnect tests passed");
