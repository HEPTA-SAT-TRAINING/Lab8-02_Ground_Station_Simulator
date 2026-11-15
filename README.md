# HEPTA-SAT Grand Station Simulator Web

A browser-based ground station simulator for HEPTA-SAT training. This repository contains a static web application designed for deployment with GitHub Pages.

## Live Site

https://hepta-sat-training.github.io/Lab8-02_Ground_Station_Simulator/

## Features

- Real-time ground station dashboard
- Reserved-pass HK observation follows the selected pass's AOS/LOS and 5° mask; ground-receiver RSSI and photo reception remain independent
- Satellite orbit and ground-track visualization
- Skyview plot with azimuth around the rim, elevation from 0° at the rim to 90° at the center, and AOS/LOS times in JST
- Telemetry reception, decoding, and display
- HEPTA-SAT V4.1.1 EPS and nine-axis history graphs
- JPEG reception with packet/image CRC validation and one-packet parity recovery
- Web Serial communication with supported serial devices

## Project Structure

- `index.html`: Application entry point
- `styles.css`: Application shell styles
- `public/ground-station.html`: Ground station interface
- `public/xbee-api.js`: XBee API mode frame/RSSI adapter
- `public/xbee-transparent.js`: AP=0 local-AT RSSI session and serialized payload writer
- `public/hepta-image-receiver.js`: telemetry/image stream adapter
- `public/vendor/hepta-serial-monitor`: pinned HEPTA-SAT Serial Monitor submodule
- `tests/verify-protocol.mjs`: fragmented serial/image protocol mock test
- `tests/verify-skyview.mjs`: skyview projection, horizon, pass-event, and JST tests
- `tests/verify-transparent-rssi.mjs`: AP=0 guard times, fragmented replies, telemetry preservation, writer queue, recovery and disconnect tests
- `tests/verify-pass-window.mjs`: reservation/time/mask boundaries, pass-switch clearing, stream isolation and mode labels
- `tests/verify-receiver-data.mjs`: independent receiver RSSI, English-only compact UI, binary HK scale profiles and zero-input warning
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

### Read the Skyview Plot

Calculate an orbit and select a pass. The red track shows its predicted path
across the local sky, not its distance from the ground station. North is 0°,
east 90°, south 180°, and west 270°. Elevation is 0° at the outer circle, 30°
and 60° on the inner rings, and 90° (zenith) at the center. The blue dot is the
satellite at the displayed simulation time; it is hidden below the horizon.

AOS and LOS markers and their JST times use the existing 5° elevation mask,
shown as a dashed ring. The path between the 0° horizon and the 5° mask is
muted. No below-horizon path or artificial line from the plot center is drawn.
The elevation-versus-time graph remains available below the skyview plot.

Run the protocol, skyview, transparent-RSSI, and reserved-pass checks with `npm test`.

### Lab8: reserve a pass before observing telemetry

1. Connect the receiver in **Basic mode (AP=0)** for the standard Lab8 exercise.
2. Calculate the orbit and reserve/select a pass above. The current workflow
   selects the first pass initially; select another table row to change it.
3. The orbit display starts ten seconds before that pass's AOS. The same
   **simulation clock**, not the PC wall clock, controls the lower observations.
4. HK telemetry values, received logs and HK histories are visible only
   during the selected AOS-inclusive/LOS-exclusive interval, while the satellite
   is at or above the existing 5° elevation mask and a receiver is connected.
5. Before AOS, after LOS, with no reserved pass, or on a disconnect, the lower
   observations show waiting/closed status. Out-of-window bytes are discarded,
   not replayed later. Switching passes/TLEs clears previous observations and
   partial HK text/binary buffers so two passes cannot be mixed.

The serial connection itself stays open: this is a GS training/observation
gate, not a change to HEPTA firmware or a physical RF cutoff. Ground-receiver
RSSI is not HK: it is read and displayed without a pass, uses wall-clock history,
and is not cleared or shifted when a pass/TLE changes or LOS is reached.
The separate command log is also retained when an observation window ends.
After a confirmed `b` / `STANDBY_MODE` response, the nine-axis values AX–MZ
display a dash and their old curves/cached readings are cleared. Voltage,
temperature and EPS HK continue updating. A confirmed `a` / `MISSION_MODE`
response enables new nine-axis readings; old values are not replayed. Explicit
mode responses take precedence over a voltage-based Power Save guess.
Photo framing is demultiplexed before the HK gate. `IMG_BEGIN` and image
packets continue through AOS/LOS and pass/TLE changes; these events do not
reset an image in progress or hide the last completed photo.

The second serial option is **Extension mode (AP=1)**, an optional extension entry
for learners who have completed Lab8. It retains the existing XBee API frame,
address and status/AT-response handling; it is not presented as an RSSI-only
mode. This naming change does not add a multi-node management interface.
The receiver's actual AP setting must still match the selected option.

### Measure the real HEPTA-to-GS RSSI

No HEPTA sketch change is required. RSSI is measured by the receiving GS XBee.
Both AP=0 and AP=1 are supported; match the browser selection to the GS radio's
actual setting. The HEPTA-side XBee can remain in Transparent mode (`AP=0`).

#### Keep the GS XBee in Transparent mode (AP=0)

1. Keep both radios in AP=0 and their local UART connections at 38400 bps.
2. On the GS radio, use the usual `CC=2B` (`+`) and `GT=3E8` (one second)
   settings. The page does not change these or write any radio configuration.
3. Select **Basic mode (AP=0)** in the page and connect the **receiving XBee's
   USB adapter**, not the OBC's native USB port.
4. RSSI acquisition runs automatically in the background after radio data
   arrives, even without a reserved pass, at roughly 15-second intervals.
   The panel contains only the value, unit and wall-clock graph, with no Auto
   checkbox or Read button. Hover over the value for the latest read/error status.
   The first sample starts at the left edge of a three-minute time axis; newer
   samples advance right. Once that interval is full, the graph scrolls to keep
   the latest three minutes. The horizontal axis is labeled Time (JST).
5. The page reserves the writer, observes guard silence, sends `+++` without
   a newline, and waits for the local `OK` before sending any AT command.
   It reads back `AP` and `CT`, queries `ATDB`, then exits with `ATCN`.
   Hexadecimal `40` is displayed as -64 dBm; `DB=0` is not a 0 dBm sample.

Local AT replies are separated from the received telemetry. Known HEPTA binary
frames are passed intact even when their payload contains `OK\r` or `40\r`.
Ordinary serial commands share the query's writer queue, so `a`, `b`, and `p`
are not written into local AT mode. Pending/active photo transfers defer new
queries. Raspberry Pi/Pico native USB ports (VID 2E8A) are excluded from AT
probing because a direct OBC USB connection has no receiving-radio RSSI.
Pass selection does not start, stop or reset RSSI acquisition. DB reports the
radio's last received RF packet/APS acknowledgement, not a simulated strength.

Command mode **briefly interrupts normal UART forwarding**. This is a sampled
last-reception value, not a per-telemetry-packet measurement. Continuous traffic
can exceed the radio's own buffers during a query; browser buffering cannot
recover RF/serial data already lost inside the radio. Use API mode for large
or uninterrupted transfers. The implementation targets the documented S2C
Zigbee defaults; unknown binary protocols/custom CC or GT are not guaranteed.

On a failed query the value's hover status explains the failure and automatic
probing pauses. Check baud rate/CC/GT and reconnect to retry.
If AT mode's exit is unconfirmed, outgoing commands are held until its CT
timeout expires. A confirmed CT value is used; otherwise the S2C Zigbee maximum
is used conservatively (up to about 67 seconds including the guard margin). Disconnect cancels scheduled work
and attempts `ATCN` only for a confirmed AT session. An immediate reconnect to
the same port retains an outstanding recovery deadline.

See [Digi's S2C Zigbee user guide](https://docs.digi.com/resources/documentation/digidocs/pdfs/90002002.pdf)
for command-mode guard times, CT/CN, and the DB last-hop measurement semantics.

#### Extension mode (AP=1)

Digi documents that API and Transparent modules remain compatible over RF
because only the RF payload is transmitted over the air.

1. Connect only the GS XBee to XCTU / XBee Studio.
2. Keep the UART baud rate at `38400` (`BD=5`).
3. Set `AP=1` (API mode without escaping).
4. For an XBee 3 802.15.4 module, set `AO=2` when that setting is available.
   This selects legacy receive frames `0x80/0x81`, which contain the per-packet
   RSSI directly. Older 802.15.4 modules already use these frame types.
5. Write the settings to the GS XBee and close XCTU so it releases the serial
   port.
6. Open the Grand Station page, select
   **XBee: Extension mode (AP=1)**, select the GS XBee port, then connect.
7. Leave the HEPTA powered and transmitting. RSSI updates from received RF
   packets regardless of the reserved HK window. Wait for one radio packet before sending
   `a`, `b`, or `p`, because the page learns the HEPTA address from that packet.

The receiver supports `0x80` and `0x81` frames with inline RSSI. It also accepts
newer `0x90` and `0x91` receive frames; because those do not carry RSSI, the
page automatically sends a local `ATDB` API request and displays the returned
last-packet value. `AP=2` escaped API mode is intentionally not supported.

To use the original Serial Monitor/transparent workflow again, restore the GS
XBee to `AP=0` and select **Basic mode (AP=0)** in the page.

### Hardware-free telemetry / RSSI check

Append `?demo=1` to the page URL to feed deterministic dummy telemetry into
the production text receiver without opening a serial port:

```text
http://localhost:8080/?demo=1
```

The demo sends Lab5-compatible HK and nine-axis records once per second.
Calculate/select a pass for HK observations; the demonstration RSSI remains
independent just like the hardware receiver RSSI. Each
HK record starts with a changing value such as `RSSI=-68`. It deliberately
splits the `RSSI` token across two receiver chunks, so a visible RSSI value and
graph verify both parsing and arbitrary Web Serial chunk buffering.

This is a UI/protocol test only. An XBee in AT/transparent mode does not stream
its measured RSSI automatically; the new AP=0 session queries it locally.
Use either of the real-radio procedures above for the HEPTA-to-GS RSSI.
Text sources containing `RSSI=-64`, `DB=40`, or backend JSON
with an `rssi` value remain supported for compatibility.

## HEPTA-SAT XBee, telemetry, and Lab compatibility

Web Serial opens the XBee adapter at **38400 baud**, matching the existing
HEPTA-SAT training XBee pair. The current Flight Software sends the same
CRLF-terminated text records as the Lab repositories. The receiver buffers
arbitrary Web Serial chunks until LF, matching HEPTA-SAT Serial Monitor.
HK observations are filtered by the selected pass window even during bench
tests; radio reception and ground RSSI acquisition remain independent.

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

The dashboard uses one fixed binary HK format matching the supplied
`HEPTA_Flightware.ino`: bus voltage in mV, temperature in 0.1°C, acceleration
in 0.01 m/s², angular rate in 0.1 deg/s, and magnetometer in 0.1 µT.
There is no format selector in the interface. Text HK is already in physical
units. A transmitter using older ADC/count scaling must be aligned with this
schema rather than being guessed from packet size or value magnitude.

The 35-byte payload appends unsigned-millivolt `V5`, `V3V3`, and `SAP`, then
signed-milliamp `ISOL`, `IBUS`, and `ICHG`.

The supplied Flightware temperature formula returns approximately 125.6°C for
ADC=0. A 0 V / 125.6°C report is therefore marked with a zero-input warning
(hover the values); it is not silently converted to room temperature. With
only an OBC and XBee, missing EPS/sensor inputs cannot supply valid satellite
measurements. This warning is a diagnostic indication, not proof of a specific
hardware fault. The GS does not replace missing measurements with dummy values.

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
If no `IMG_BEGIN` arrives within 60 seconds, the capture indicator stops with
a timeout message. This does not imply camera success or fabricate a photo.
An empty preview stays hidden instead of showing a broken-image placeholder.

## Verification

Run the mock protocol test with Node.js:

```bash
npm test
```

It exercises the pinned Serial Monitor modules through the production adapter
and verifies arbitrary stream fragmentation, image reconstruction, CRC-16,
one-packet parity recovery, and preservation of telemetry bytes before and
after an image transfer.
