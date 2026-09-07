<script lang="ts">
  import {
    dateFromInitTimeIdx,
    ECMWF_INIT_TIME_ORIGIN,
    ECMWF_LEAD_TIME_COUNT,
    ECMWF_LEAD_TIME_HOURS,
    initTimeIdxFromDate,
    isoDateString,
  } from "../ecmwf/metadata.js";

  type ColormapId = "thermal" | "coolwarm";

  type Props = {
    leadTimeIdx: number;
    initTimeIdx: number;
    initTimeCount: number;
    isPlaying: boolean;
    colormapId: ColormapId;
    opacity: number;
    frameDurationMs: number;
    statusMessage: string;
    onLeadTimeIdxChange: (idx: number) => void;
    onInitTimeIdxChange: (idx: number) => void;
    onPlayPauseToggle: () => void;
    onColormapIdChange: (id: ColormapId) => void;
    onOpacityChange: (v: number) => void;
    onFrameDurationMsChange: (v: number) => void;
  };

  let {
    leadTimeIdx,
    initTimeIdx,
    initTimeCount,
    isPlaying,
    colormapId,
    opacity,
    frameDurationMs,
    statusMessage,
    onLeadTimeIdxChange,
    onInitTimeIdxChange,
    onPlayPauseToggle,
    onColormapIdChange,
    onOpacityChange,
    onFrameDurationMsChange,
  }: Props = $props();

  let hours = $derived(ECMWF_LEAD_TIME_HOURS[leadTimeIdx] ?? 0);
  let minDate = $derived(isoDateString(ECMWF_INIT_TIME_ORIGIN));
  let maxDate = $derived(
    initTimeCount > 0
      ? isoDateString(dateFromInitTimeIdx(initTimeCount - 1))
      : undefined,
  );
  let currentDate = $derived(isoDateString(dateFromInitTimeIdx(initTimeIdx)));

  function handleDateChange(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    if (!value) return;
    onInitTimeIdxChange(
      initTimeIdxFromDate(
        new Date(`${value}T00:00:00Z`),
        Math.max(0, initTimeCount - 1),
      ),
    );
  }
</script>

<div class="panel">
  <h2>ECMWF IFS ENS &mdash; 2 m Temperature</h2>
  <p class="hint">@carbonplan/zarr-layer + MapLibre</p>

  {#if statusMessage}
    <p class="status">{statusMessage}</p>
  {/if}

  <label class="field">
    <span>Forecast date</span>
    <input
      type="date"
      min={minDate}
      max={maxDate}
      value={currentDate}
      onchange={handleDateChange}
    />
  </label>

  <label class="field">
    <span>Lead time: +{hours} h</span>
    <div class="row">
      <button
        class="icon-btn"
        onclick={onPlayPauseToggle}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>
      <input
        type="range"
        min="0"
        max={ECMWF_LEAD_TIME_COUNT - 1}
        value={leadTimeIdx}
        oninput={(e) =>
          onLeadTimeIdxChange(Number((e.target as HTMLInputElement).value))}
      />
    </div>
    <p class="hint">
      Each step calls <code>layer.setSelector()</code>, which triggers a fresh
      HTTP fetch — there's no pre-loaded animation buffer like the
      deck.gl-raster demo, so playback is deliberately throttled.
    </p>
  </label>

  <label class="field">
    <span>Colormap</span>
    <select
      value={colormapId}
      onchange={(e) =>
        onColormapIdChange((e.target as HTMLSelectElement).value as ColormapId)}
    >
      <option value="thermal">thermal</option>
      <option value="coolwarm">coolwarm (diverging)</option>
    </select>
  </label>

  <label class="field">
    <span>Opacity: {opacity.toFixed(2)}</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={opacity}
      oninput={(e) =>
        onOpacityChange(Number((e.target as HTMLInputElement).value))}
    />
  </label>

  <label class="field">
    <span>Min frame interval: {frameDurationMs} ms</span>
    <input
      type="range"
      min="150"
      max="1000"
      step="50"
      value={frameDurationMs}
      oninput={(e) =>
        onFrameDurationMsChange(Number((e.target as HTMLInputElement).value))}
    />
  </label>

  <p class="credit">
    <a
      href="https://dynamical.org/catalog/ecmwf-ifs-ens-forecast-15-day-0-25-degree/"
      target="_blank"
      rel="noreferrer"
    >
      ECMWF IFS ENS Forecast data
    </a>
    processed by dynamical.org from ECMWF Open Data.
  </p>
</div>

<style>
  .panel {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 320px;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    background: rgba(20, 20, 20, 0.92);
    color: #eee;
    border-radius: 8px;
    padding: 16px;
    font-size: 13px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  h2 {
    font-size: 14px;
    margin: 0 0 4px;
  }
  .field {
    display: block;
    margin: 12px 0;
  }
  .field > span {
    display: block;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input[type="range"] {
    flex: 1;
    width: 100%;
  }
  input[type="date"],
  select {
    width: 100%;
    padding: 4px;
    background: #222;
    color: #eee;
    border: 1px solid #444;
    border-radius: 4px;
  }
  .icon-btn {
    flex-shrink: 0;
    background: #333;
    border: 1px solid #444;
    color: #eee;
    border-radius: 4px;
    width: 28px;
    height: 28px;
    cursor: pointer;
  }
  .hint {
    margin: 4px 0 0;
    font-size: 11px;
    color: #999;
  }
  .hint code {
    background: #2a2a2a;
    padding: 1px 4px;
    border-radius: 3px;
  }
  .status {
    background: #33291a;
    border: 1px solid #665633;
    color: #f0d090;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 12px;
  }
  .credit {
    margin: 12px 0 0;
    padding-top: 8px;
    border-top: 1px solid #444;
    font-size: 11px;
    color: #999;
  }
  .credit a {
    color: #8ab4f8;
  }
</style>
