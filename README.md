# HEPTA-SAT Grand Station Simulator Web

A browser-based ground station simulator for HEPTA-SAT training. This repository contains a static web application designed for deployment with GitHub Pages.

## Live Site

https://hepta-sat-training.github.io/Lab8-02_Ground_Station_Simulator/

## Features

- Real-time ground station dashboard
- Satellite orbit and ground-track visualization
- Telemetry reception, decoding, and display
- HEPTA-SAT V4.1.1 EPS and nine-axis history graphs
- JPEG reception with packet/image CRC validation and one-packet parity recovery
- Web Serial communication with supported serial devices

## Project Structure

- `index.html`: Application entry point
- `styles.css`: Application shell styles
- `public/ground-station.html`: Ground station interface
- `public/xbee-api.js`: XBee API mode frame/RSSI adapter
- `public/hepta-image-receiver.js`: telemetry/image stream adapter
- `public/vendor/hepta-serial-monitor`: pinned HEPTA-SAT Serial Monitor submodule
- `tests/verify-protocol.mjs`: fragmented serial/image protocol mock test
- `public/`: Maps, orbit libraries, and Three.js assets
- `.github/workflows/pages.yml`: GitHub Pages deployment workflow

## Local Development

Clone with the fixed protocol dependency:

```bash
git clone --recurse-submodules \
  https://github.com/HEPTA-SAT-TRAINING/HEPTA-SAT-Grand-Station-Simulator-Web.git
cd HEPTA-SAT-Grand-Station-Simulator-Web
git submodule status
```

For an existing clone or after switching branches:

```bash
git submodule sync --recursive
git submodule update --init --recursive
git submodule status
```

The Serial Monitor dependency is pinned by the parent gitlink to commit
`399e8ff64f762a4aacfa5d6e518e9d3905738d6a`. Do not use
`git submodule update --remote` for a normal build, because that bypasses the
reproducible version selected by this repository.

Serve the repository through a local HTTP server instead of opening the files directly:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/` in Chrome or Edge. Web Serial requires a secure context, such as HTTPS or localhost, and a compatible browser.

### Measure the real HEPTA-to-GS RSSI

No HEPTA sketch change is required. RSSI is measured by the receiving GS XBee,
so only the **GS-side XBee UART mode** and the browser selection need to change.
The HEPTA-side XBee can remain in Transparent mode (`AP=0`). Digi documents
that API and Transparent modules remain compatible over RF because only the RF
payload is transmitted over the air.

1. Connect only the GS XBee to XCTU / XBee Studio.
2. Keep the UART baud rate at `38400` (`BD=5`).
3. Set `AP=1` (API mode without escaping).
4. For an XBee 3 802.15.4 module, set `AO=2` when that setting is available.
   This selects legacy receive frames `0x80/0x81`, which contain the per-packet
   RSSI directly. Older 802.15.4 modules already use these frame types.
5. Write the settings to the GS XBee and close XCTU so it releases the serial
   port.
6. Open the Grand Station page, select
   **XBee: API (AP=1 / Real RSSI)**, select the GS XBee port, then connect.
7. Leave the HEPTA powered and transmitting HK. The RSSI value and graph update
   from each received RF packet. Wait for one telemetry packet before sending
   `a`, `b`, or `p`, because the page learns the HEPTA address from that packet.

The receiver supports `0x80` and `0x81` frames with inline RSSI. It also accepts
newer `0x90` and `0x91` receive frames; because those do not carry RSSI, the
page automatically sends a local `ATDB` API request and displays the returned
last-packet value. `AP=2` escaped API mode is intentionally not supported.

To use the original Serial Monitor/transparent workflow again, restore the GS
XBee to `AP=0` and select **Transparent (AP=0)** in the page.

### Hardware-free telemetry / RSSI check

Append `?demo=1` to the page URL to feed deterministic dummy telemetry into
the production text receiver without opening a serial port:

```text
http://localhost:8080/?demo=1
```

The demo sends Lab5-compatible HK and nine-axis records once per second. Each
HK record starts with a changing value such as `RSSI=-68`. It deliberately
splits the `RSSI` token across two receiver chunks, so a visible RSSI value and
graph verify both parsing and arbitrary Web Serial chunk buffering.

This is a UI/protocol test only. An XBee in AT/transparent mode does not stream
its measured RSSI automatically. Use the API-mode procedure above for the real
HEPTA-to-GS RSSI. Text sources containing `RSSI=-64`, `DB=40`, or backend JSON
with an `rssi` value remain supported for compatibility.

## HEPTA-SAT XBee, telemetry, and Lab compatibility

Web Serial opens the XBee adapter at **38400 baud**, matching the existing
HEPTA-SAT training XBee pair. The current Flight Software sends the same
CRLF-terminated text records as the Lab repositories. The receiver buffers
arbitrary Web Serial chunks until LF, matching HEPTA-SAT Serial Monitor.
Received hardware telemetry is displayed during bench tests regardless of the
simulated satellite elevation.

The exact Lab5-03 HK record is:

```text
TEMP=...,BUS=...,V5=...,V3V3=...,SAP=...,ISOL=...,IBUS=...,ICHG=...
```

After `a`, the Mission record extends the Lab5-04 acceleration fields with the
remaining BNO055 axes:

```text
AX=...,AY=...,AZ=...,GX=...,GY=...,GZ=...,MX=...,MY=...,MZ=...
```

The parser updates only valid fields, retains prior values when a record is
partial, and ignores unknown or non-numeric assignments. HK and nine-axis
values are added to the existing history graphs with V, A, °C, m/s², deg/s,
and µT units.

For compatibility with earlier HEPTA-SAT Flight Software, the existing binary
frame decoder remains available. It accepts the following payload lengths:

- 5 bytes: legacy bus voltage and temperature
- 23 bytes: legacy bus voltage, temperature, and nine-axis data
- 35 bytes: the same 23-byte prefix plus Lab5-03 EPS data

The 35-byte payload appends unsigned-millivolt `V5`, `V3V3`, and `SAP`, then
signed-milliamp `ISOL`, `IBUS`, and `ICHG` fields. Existing offsets and value
conversions remain unchanged: bus voltage ADC count
(`V / (3.3 * 1.431) * 4096`), temperature (`degC * 10`), acceleration
(`m/s2 / 9.8 * 512`), gyro (`deg/s * 2048 / 125`), and integer magnetometer µT.

Commands `a`, `b`, and `p` are restricted to one character. In Transparent
mode they are sent as plain bytes with no line ending, matching HEPTA-SAT
Serial Monitor and the Lab sketches. In API mode the same one-byte payload is
wrapped in a transmit request addressed to the source of the latest received
packet. `a` selects Mission, `b` selects Standby, and `p` starts the Lab5-05
JPEG protocol:

```text
IMG_BEGIN\n
HP START/DATA/PARITY/END packets
\nIMG_END\n
```

`public/hepta-image-receiver.js` delegates packet parsing, packet CRC checking,
full-image CRC checking, and XOR parity reconstruction to the public modules in
the pinned HEPTA-SAT Serial Monitor submodule. It only adds stream
demultiplexing, timeout handling, JPEG marker validation, and UI callbacks; the
external implementation is not copied or modified.

The receiver accepts arbitrary Web Serial chunk boundaries and can recover one
missing/corrupt DATA packet. Images are limited to 4,194,048 bytes by the
Library's 64-byte DATA payload and 16-bit packet-count fields. Packet timeout is
10 seconds and overall image timeout is 60 seconds. Image processing is
event-driven, so the page UI remains responsive during reception. The GitHub
Pages workflow also initializes submodules before publishing.

## Dashboard display controls

The **Display Features** control in the dashboard header opens a checklist for the
orbit, tracking, telemetry, image, packet-log, and command panels. Hiding a
panel only changes the layout; it does not stop serial reception or telemetry
history collection. The selected panel set is saved in browser local storage.

The **Display Graphs** control beside **Telemetry History** independently enables
temperature, voltage, EPS voltage, current, acceleration, angular-rate, and
magnetic-field graphs. At least one graph remains selected, and the selection
is also restored after a reload. This keeps the default dashboard readable
while still allowing every received telemetry series to be inspected when
needed.

During a `p` command the photo panel first shows an indeterminate capture
state. Once the Serial Monitor `START` packet is received it switches to a
byte-based progress bar (`received bytes / image bytes`) and packet count. A
capture or transfer error is reported in the same panel instead of leaving a
permanent `WAIT` state.

## Verification

Run the mock protocol test with Node.js:

```bash
npm test
```

It exercises the pinned Serial Monitor modules through the production adapter
and verifies arbitrary stream fragmentation, image reconstruction, CRC-16,
one-packet parity recovery, and preservation of telemetry bytes before and
after an image transfer.
