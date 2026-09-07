<script lang="ts">
  import {
    COLORMAP_CHOICES,
    type ColormapId,
  } from "../ecmwf/colormap-choices.js";
  import {
    dateFromInitTimeIdx,
    ECMWF_INIT_TIME_ORIGIN,
    ECMWF_LEAD_TIME_COUNT,
    ECMWF_LEAD_TIME_HOURS,
    initTimeIdxFromDate,
    isoDateString,
  } from "../ecmwf/metadata.js";

  const TEMP_SLIDER_MIN = -80;
  const TEMP_SLIDER_MAX = 60;
  const TEMP_SLIDER_STEP = 1;

  const FRAME_MS_MIN = 50;
  const FRAME_MS_MAX = 300;
  const FRAME_MS_STEP = 10;

  type Props = {
    leadTimeIdx: number;
    initTimeIdx: number;
    initTimeCount: number;
    isPlaying: boolean;
    colormapId: ColormapId;
    rescaleMin: number;
    rescaleMax: number;
    filterMin: number;
    filterMax: number;
    frameDurationMs: number;
    onLeadTimeIdxChange: (idx: number) => void;
    onInitTimeIdxChange: (idx: number) => void;
    onPlayPauseToggle: () => void;
    onColormapIdChange: (id: ColormapId) => void;
    onRescaleMinChange: (v: number) => void;
    onRescaleMaxChange: (v: number) => void;
    onFilterMinChange: (v: number) => void;
    onFilterMaxChange: (v: number) => void;
    onFrameDurationMsChange: (v: number) => void;
  };

  let {
    leadTimeIdx,
    initTimeIdx,
    initTimeCount,
    isPlaying,
    colormapId,
    rescaleMin,
    rescaleMax,
    filterMin,
    filterMax,
    frameDurationMs,
    onLeadTimeIdxChange,
    onInitTimeIdxChange,
    onPlayPauseToggle,
    onColormapIdChange,
    onRescaleMinChange,
    onRescaleMaxChange,
    onFilterMinChange,
    onFilterMaxChange,
    onFrameDurationMsChange,
  }: Props = $props();

  let hours = $derived(ECMWF_LEAD_TIME_HOURS[leadTimeIdx] ?? 0);
  let selectedChoice = $derived(
    COLORMAP_CHOICES.find((c) => c.id === colormapId) ?? COLORMAP_CHOICES[0],
  );
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

  <label class="field">
    <span>Forecast date</span>
    <input
      type="date"
      min={minDate}
      max={maxDate}
      value={currentDate}
      disabled={initTimeCount === 0}
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
      3-hourly from +0h to +144h (48 steps), then 6-hourly from +150h to
      +360h (37 steps). 6h steps dwell twice as long during animation so the
      simulated-time pacing stays constant.
    </p>
  </label>

  <label class="field">
    <span>Colormap</span>
    <select
      value={colormapId}
      onchange={(e) =>
        onColormapIdChange((e.target as HTMLSelectElement).value as ColormapId)}
    >
      {#each COLORMAP_CHOICES as c (c.id)}
        <option value={c.id}>{c.label}</option>
      {/each}
    </select>
  </label>
  <p class="hint">
    {selectedChoice.label}{selectedChoice.reversed ? " (reversed)" : ""}
  </p>

  <label class="field">
    <span>Rescale range: {rescaleMin}&deg;C &ndash; {rescaleMax}&deg;C</span>
    <div class="row">
      <input
        type="range"
        min={TEMP_SLIDER_MIN}
        max={TEMP_SLIDER_MAX}
        step={TEMP_SLIDER_STEP}
        value={rescaleMin}
        oninput={(e) =>
          onRescaleMinChange(Number((e.target as HTMLInputElement).value))}
      />
      <input
        type="range"
        min={TEMP_SLIDER_MIN}
        max={TEMP_SLIDER_MAX}
        step={TEMP_SLIDER_STEP}
        value={rescaleMax}
        oninput={(e) =>
          onRescaleMaxChange(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  </label>

  <label class="field">
    <span>Filter range: {filterMin}&deg;C &ndash; {filterMax}&deg;C</span>
    <div class="row">
      <input
        type="range"
        min={TEMP_SLIDER_MIN}
        max={TEMP_SLIDER_MAX}
        step={TEMP_SLIDER_STEP}
        value={filterMin}
        oninput={(e) =>
          onFilterMinChange(Number((e.target as HTMLInputElement).value))}
      />
      <input
        type="range"
        min={TEMP_SLIDER_MIN}
        max={TEMP_SLIDER_MAX}
        step={TEMP_SLIDER_STEP}
        value={filterMax}
        oninput={(e) =>
          onFilterMaxChange(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  </label>

  <label class="field">
    <span>3h step: {frameDurationMs} ms</span>
    <input
      type="range"
      min={FRAME_MS_MIN}
      max={FRAME_MS_MAX}
      step={FRAME_MS_STEP}
      value={frameDurationMs}
      oninput={(e) =>
        onFrameDurationMsChange(Number((e.target as HTMLInputElement).value))}
    />
    <p class="hint">6h steps (after +144h) dwell twice as long.</p>
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
    margin: 0 0 12px;
  }
  .field {
    display: block;
    margin-bottom: 12px;
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
