// Deterministic bench data for checking the dashboard without serial hardware.
// Enable it with `?demo=1` on either index.html or ground-station.html.
export function createDemoTelemetryLines(sampleIndex = 0) {
  const phase = Number(sampleIndex) || 0;
  const wave = Math.sin(phase / 4);
  const slowWave = Math.sin(phase / 9);
  const rssiDbm = Math.round(-68 + wave * 10);
  const temperatureC = 24.2 + slowWave * 1.8;
  const busVoltageV = 3.78 + wave * 0.06;
  const solarVoltageV = 4.15 + Math.max(0, slowWave) * 0.35;

  return [
    [
      `RSSI=${rssiDbm}`,
      `TEMP=${temperatureC.toFixed(2)}`,
      `BUS=${busVoltageV.toFixed(3)}`,
      "V5=5.002",
      "V3V3=3.301",
      `SAP=${solarVoltageV.toFixed(3)}`,
      `ISOL=${(0.105 + wave * 0.018).toFixed(3)}`,
      `IBUS=${(0.218 + slowWave * 0.022).toFixed(3)}`,
      `ICHG=${(0.032 + Math.max(0, wave) * 0.012).toFixed(3)}`,
    ].join(",") + "\r\n",
    [
      `AX=${(0.04 * wave).toFixed(2)}`,
      `AY=${(0.03 * slowWave).toFixed(2)}`,
      `AZ=${(9.80 + 0.05 * wave).toFixed(2)}`,
      `GX=${(0.20 * wave).toFixed(2)}`,
      `GY=${(0.15 * slowWave).toFixed(2)}`,
      `GZ=${(-0.10 * wave).toFixed(2)}`,
      `MX=${(21.0 + wave).toFixed(2)}`,
      `MY=${(-4.0 + slowWave).toFixed(2)}`,
      `MZ=${(38.0 + wave * 0.8).toFixed(2)}`,
    ].join(",") + "\r\n",
  ];
}
