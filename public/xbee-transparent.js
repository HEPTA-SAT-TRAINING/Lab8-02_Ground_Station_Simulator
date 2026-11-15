const ENCODER = new TextEncoder();
const ASCII = new TextDecoder("latin1");
const MAX_CT_MS = 0x28f * 100;
const REPLY_BUFFER_LIMIT = 128;

function cancelled() {
  return new Error("Transparent RSSI session closed");
}

function heptaFrameLength(bytes) {
  if (bytes[0] !== 0x7e) return 0;
  if (bytes.length < 3) return -1;
  if (bytes[2] !== 0x10 && bytes[2] !== 0x11) return 0;
  if (bytes.length < 6) return -1;
  return bytes[5] > 0 && bytes[5] <= 64 ? 7 + bytes[5] : 0;
}

/**
 * Read local ATDB without changing AP, CC, GT, or any persisted radio setting.
 * All outgoing payloads share the same queue as the guard/AT transaction.
 * Call push() from the sole serial reader; do not open a competing reader.
 */
export class TransparentRssiSession {
  constructor({
    write, onPayload = () => {}, onRssi = () => {}, onStatus = () => {},
    isBusy = () => false, guardMs = 1200, replyTimeoutMs = 1200,
    intervalMs = 15000, recoveryUntil = 0,
    now = () => Date.now(),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = id => clearTimeout(id),
  }) {
    if (typeof write !== "function") throw new TypeError("A serial writer is required");
    Object.assign(this, { write, onPayload, onRssi, onStatus, isBusy, guardMs,
      replyTimeoutMs, intervalMs, now, setTimer, clearTimer, recoveryUntil });
    this.active = true;
    this.closing = false;
    this.auto = false;
    this.failed = false;
    this.seenPayload = false;
    this.mode = recoveryUntil > now() ? "uncertain" : "data";
    this.commandTimeoutMs = MAX_CT_MS;
    this.lastWriteAt = now();
    this.tail = Promise.resolve();
    this.pollPromise = null;
    this.pollTimer = null;
    this.reply = null;
    this.replyBytes = [];
    this.cancellations = new Set();
  }

  status(state, message) {
    this.onStatus({ state, message });
  }

  setAuto(enabled) {
    this.auto = Boolean(enabled);
    this.failed = false;
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    if (this.auto && this.active && !this.closing) {
      this.status("waiting", "Waiting for received radio data.");
      this.schedule(0);
    } else if (this.active && !this.closing) {
      this.status("idle", "RSSI polling disabled.");
    }
  }

  schedule(delay = this.intervalMs) {
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    if (!this.auto || !this.active || this.closing || this.failed) return;
    this.pollTimer = this.setTimer(async () => {
      this.pollTimer = null;
      if (!this.seenPayload || this.isBusy()) {
        if (this.isBusy()) this.status("paused", "AP=0: RSSI paused during photo transfer");
        this.schedule(1000);
        return;
      }
      try { await this.poll(); } catch { /* poll reports its own error */ }
      this.schedule();
    }, delay);
  }

  enqueue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  assertOpen(allowClosing = false) {
    if (!this.active || (this.closing && !allowClosing)) throw cancelled();
  }

  delay(ms, allowClosing = false) {
    this.assertOpen(allowClosing);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        this.clearTimer(timer);
        this.cancellations.delete(abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(cancelled());
      const timer = this.setTimer(() => finish(), ms);
      this.cancellations.add(abort);
    });
  }

  async rawWrite(bytes, allowClosing = false) {
    this.assertOpen(allowClosing);
    this.lastWriteAt = this.now();
    // Even a failed/partial write may have reached the radio.
    if (this.mode !== "data") {
      this.recoveryUntil = this.lastWriteAt + this.commandTimeoutMs + this.guardMs;
    }
    await this.write(bytes);
  }

  emitPayload(bytes) {
    if (!bytes.length) return;
    this.seenPayload = true;
    this.onPayload(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  flushReplyBytes() {
    if (this.replyBytes.length) this.emitPayload(new Uint8Array(this.replyBytes));
    this.replyBytes = [];
  }

  expectReply(kind, timeoutMs = this.replyTimeoutMs, allowClosing = false) {
    this.assertOpen(allowClosing);
    if (this.reply) throw new Error("Another local AT reply is pending");
    let finish;
    const promise = new Promise((resolve, reject) => {
      const timer = this.setTimer(() => finish(new Error(`XBee ${kind} reply timed out`)), timeoutMs);
      const abort = () => finish(cancelled());
      finish = (error, text) => {
        if (this.reply?.finish !== finish) return;
        this.clearTimer(timer);
        this.cancellations.delete(abort);
        this.reply = null;
        this.flushReplyBytes();
        if (error) reject(error); else resolve(text);
      };
      this.reply = { kind, finish };
      this.cancellations.add(abort);
    });
    // A writer may reject before the caller reaches await promise.
    promise.catch(() => {});
    return { promise, cancel: error => finish(error || cancelled()) };
  }

  push(chunk) {
    if (!chunk?.length) return;
    if (!this.reply) {
      this.emitPayload(chunk);
      return;
    }
    for (const byte of chunk) this.replyBytes.push(byte);
    let end;
    while (this.reply) {
      end = this.replyBytes.indexOf(13);
      const header = this.replyBytes.indexOf(0x7e);
      if (header >= 0 && (end < 0 || header < end)) {
        if (header > 0) {
          this.emitPayload(new Uint8Array(this.replyBytes.splice(0, header)));
          continue;
        }
        const length = heptaFrameLength(this.replyBytes);
        if (length < 0 || (length > 0 && this.replyBytes.length < length)) break;
        if (length > 0) {
          // A binary payload can itself contain OK\r or hexadecimal + CR.
          // Never interpret bytes inside a HEPTA frame as an AT response.
          this.emitPayload(new Uint8Array(this.replyBytes.splice(0, length)));
          continue;
        }
      }
      if (end < 0) break;
      const line = this.replyBytes.splice(0, end + 1);
      const body = line.slice(0, -1);
      const text = ASCII.decode(new Uint8Array(body)).replace(/^\n/, "");
      const { kind, finish } = this.reply;
      let response = null;
      if (kind === "enter") {
        if (text === "OK") {
          response = "OK";
          this.mode = "command";
        }
      } else if (text === "ERROR" || text === "OK") {
        response = text;
      } else if ((kind === "hex" && /^[0-9A-Fa-f]{1,3}$/.test(text)) || (kind === "db" && /^[0-9A-Fa-f]{1,2}$/.test(text))) {
        response = text;
      }
      if (response !== null) {
        if (response === "ERROR") finish(new Error("XBee rejected the local AT command"));
        else finish(null, response);
      } else if (this.mode !== "command" || (text !== "" && !/^AT(?:AP|CT|DB|CN)$/.test(text))) {
        // Unrelated RF data is passed through byte-for-byte, including CR.
        this.emitPayload(new Uint8Array(line));
      }
    }
    if (this.replyBytes.length > REPLY_BUFFER_LIMIT) {
      this.emitPayload(new Uint8Array(this.replyBytes.splice(0, this.replyBytes.length - 8)));
    }
  }

  async command(command, kind, allowClosing = false) {
    const pending = this.expectReply(kind, this.replyTimeoutMs, allowClosing);
    try {
      await this.rawWrite(ENCODER.encode(`${command}\r`), allowClosing);
      return await pending.promise;
    } catch (error) {
      pending.cancel(error);
      throw error;
    }
  }

  async waitForDataMode() {
    if (this.mode === "uncertain") {
      const remaining = this.recoveryUntil - this.now();
      if (remaining > 0) {
        this.status("recovering", `AP=0: waiting up to ${Math.ceil(remaining / 1000)} s for AT mode to expire; commands held`);
        await this.delay(remaining);
      }
      this.mode = "data";
      this.recoveryUntil = 0;
    }
    this.assertOpen();
  }

  writePayload(bytes) {
    return this.enqueue(async () => {
      await this.waitForDataMode();
      await this.rawWrite(bytes);
    });
  }

  poll() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.enqueue(() => this.pollOnce()).finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  async pollOnce() {
    await this.waitForDataMode();
    if (this.isBusy()) {
      this.status("paused", "AP=0: RSSI paused during photo transfer");
      return null;
    }
    let db = null;
    let failure = null;
    try {
      this.status("guard", "AP=0: checking RSSI; serial forwarding may pause briefly");
      await this.delay(this.guardMs - (this.now() - this.lastWriteAt));
      if (this.isBusy()) {
        this.status("paused", "AP=0: RSSI paused during photo transfer");
        return null;
      }
      const pending = this.expectReply("enter", this.guardMs + this.replyTimeoutMs);
      this.mode = "uncertain";
      try {
        await this.rawWrite(ENCODER.encode("+++")); // Deliberately no CR/LF.
        await this.delay(this.guardMs);
        if (await pending.promise !== "OK") throw new Error("Command mode not confirmed");
      } catch (error) {
        pending.cancel(error);
        throw error;
      }
      this.mode = "command";
      // A photo that started during the guard period takes precedence.
      if (!this.isBusy()) {
        const ap = await this.command("ATAP", "hex");
        if (ap !== "0" && ap !== "00") throw new Error(`Module AP=${ap}; select the matching GS mode`);
        const ct = parseInt(await this.command("ATCT", "hex"), 16);
        if (!Number.isFinite(ct) || ct < 2 || ct > 0x28f) throw new Error("Invalid command-mode timeout");
        this.commandTimeoutMs = ct * 100;
        const value = await this.command("ATDB", "db");
        if (!/^[0-9a-f]{1,2}$/i.test(value)) throw new Error("Invalid RSSI response");
        const magnitude = parseInt(value, 16);
        if (magnitude > 0) {
          db = -magnitude;
          this.onRssi(db);
        } else {
          this.onRssi(null);
        }
      }
    } catch (error) {
      failure = error;
      // Do not repeatedly send +++ to a mismatched or non-XBee serial device.
      this.failed = true;
    } finally {
      if (this.mode === "command") {
        try {
          if (await this.command("ATCN", "ok", true) !== "OK") throw new Error("Exit not confirmed");
          this.mode = "data";
          this.recoveryUntil = 0;
        } catch (error) {
          this.mode = "uncertain";
          this.failed = true;
          failure = error;
        }
      }
      this.flushReplyBytes();
    }
    if (!this.closing) {
      if (failure) {
        const held = this.mode === "uncertain" ? " Commands held until AT mode expires." : "";
        this.status("error", `AP=0 RSSI unavailable: ${failure.message}. Auto read paused; check GT=3E8, CC=2B and baud.${held}`);
      } else {
        this.status(db === null ? "waiting" : "measured", db === null
          ? "AP=0: no recent RF RSSI (DB=0), or photo transfer in progress"
          : `AP=0: measured ${db} dBm (local ATDB)`);
      }
    }
    if (failure) throw failure;
    return db;
  }

  async close() {
    if (this.closing) return this.tail;
    this.closing = true;
    this.auto = false;
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    // Cancel guards/reply waits, but let pollOnce's finally issue ATCN if
    // command mode was confirmed. Keep the serial reader running until done.
    for (const cancel of [...this.cancellations]) cancel();
    await this.tail;
    this.active = false;
    this.flushReplyBytes();
  }
}
