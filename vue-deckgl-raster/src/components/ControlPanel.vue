<script setup lang="ts">
import { computed } from "vue";
import {
  COLORMAP_CHOICES,
  type ColormapId,
} from "../ecmwf/colormap-choices";
import {
  dateFromInitTimeIdx,
  ECMWF_INIT_TIME_ORIGIN,
  ECMWF_LEAD_TIME_COUNT,
  ECMWF_LEAD_TIME_HOURS,
  initTimeIdxFromDate,
  isoDateString,
} from "../ecmwf/metadata";

const TEMP_SLIDER_MIN = -80;
const TEMP_SLIDER_MAX = 60;
const TEMP_SLIDER_STEP = 1;

const FRAME_MS_MIN = 50;
const FRAME_MS_MAX = 300;
const FRAME_MS_STEP = 10;

const props = defineProps<{
  initTimeCount: number;
  isPlaying: boolean;
}>();

const emit = defineEmits<{
  playPauseToggle: [];
}>();

// Two-way bound controls use defineModel — Vue's built-in equivalent of the
// Svelte port's callback-prop pattern (onLeadTimeIdxChange, etc.), but
// without writing the callback plumbing by hand: the parent just does
// `v-model:lead-time-idx="leadTimeIdx"`.
const leadTimeIdx = defineModel<number>("leadTimeIdx", { required: true });
const initTimeIdx = defineModel<number>("initTimeIdx", { required: true });
const colormapId = defineModel<ColormapId>("colormapId", { required: true });
const rescaleMin = defineModel<number>("rescaleMin", { required: true });
const rescaleMax = defineModel<number>("rescaleMax", { required: true });
const filterMin = defineModel<number>("filterMin", { required: true });
const filterMax = defineModel<number>("filterMax", { required: true });
const frameDurationMs = defineModel<number>("frameDurationMs", {
  required: true,
});

const hours = computed(() => ECMWF_LEAD_TIME_HOURS[leadTimeIdx.value] ?? 0);
const selectedChoice = computed(
  () =>
    COLORMAP_CHOICES.find((c) => c.id === colormapId.value) ??
    COLORMAP_CHOICES[0],
);
const minDate = computed(() => isoDateString(ECMWF_INIT_TIME_ORIGIN));
const maxDate = computed(() =>
  props.initTimeCount > 0
    ? isoDateString(dateFromInitTimeIdx(props.initTimeCount - 1))
    : undefined,
);
const currentDate = computed(() =>
  isoDateString(dateFromInitTimeIdx(initTimeIdx.value)),
);

function handleDateChange(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  if (!value) return;
  initTimeIdx.value = initTimeIdxFromDate(
    new Date(`${value}T00:00:00Z`),
    Math.max(0, props.initTimeCount - 1),
  );
}
</script>

<template>
  <div class="panel">
    <h2>ECMWF IFS ENS &mdash; 2 m Temperature</h2>

    <label class="field">
      <span>Forecast date</span>
      <input
        type="date"
        :min="minDate"
        :max="maxDate"
        :value="currentDate"
        :disabled="initTimeCount === 0"
        @change="handleDateChange"
      />
    </label>

    <label class="field">
      <span>Lead time: +{{ hours }} h</span>
      <div class="row">
        <button
          class="icon-btn"
          :aria-label="isPlaying ? 'Pause' : 'Play'"
          @click="emit('playPauseToggle')"
        >
          {{ isPlaying ? "⏸" : "▶" }}
        </button>
        <input
          type="range"
          min="0"
          :max="ECMWF_LEAD_TIME_COUNT - 1"
          v-model.number="leadTimeIdx"
        />
      </div>
      <p class="hint">
        3-hourly from +0h to +144h (48 steps), then 6-hourly from +150h to
        +360h (37 steps). 6h steps dwell twice as long during animation so
        the simulated-time pacing stays constant.
      </p>
    </label>

    <label class="field">
      <span>Colormap</span>
      <select v-model="colormapId">
        <option v-for="c in COLORMAP_CHOICES" :key="c.id" :value="c.id">
          {{ c.label }}
        </option>
      </select>
    </label>
    <p class="hint">
      {{ selectedChoice.label
      }}{{ selectedChoice.reversed ? " (reversed)" : "" }}
    </p>

    <label class="field">
      <span
        >Rescale range: {{ rescaleMin }}&deg;C &ndash;
        {{ rescaleMax }}&deg;C</span
      >
      <div class="row">
        <input
          type="range"
          :min="TEMP_SLIDER_MIN"
          :max="TEMP_SLIDER_MAX"
          :step="TEMP_SLIDER_STEP"
          v-model.number="rescaleMin"
        />
        <input
          type="range"
          :min="TEMP_SLIDER_MIN"
          :max="TEMP_SLIDER_MAX"
          :step="TEMP_SLIDER_STEP"
          v-model.number="rescaleMax"
        />
      </div>
    </label>

    <label class="field">
      <span
        >Filter range: {{ filterMin }}&deg;C &ndash;
        {{ filterMax }}&deg;C</span
      >
      <div class="row">
        <input
          type="range"
          :min="TEMP_SLIDER_MIN"
          :max="TEMP_SLIDER_MAX"
          :step="TEMP_SLIDER_STEP"
          v-model.number="filterMin"
        />
        <input
          type="range"
          :min="TEMP_SLIDER_MIN"
          :max="TEMP_SLIDER_MAX"
          :step="TEMP_SLIDER_STEP"
          v-model.number="filterMax"
        />
      </div>
    </label>

    <label class="field">
      <span>3h step: {{ frameDurationMs }} ms</span>
      <input
        type="range"
        :min="FRAME_MS_MIN"
        :max="FRAME_MS_MAX"
        :step="FRAME_MS_STEP"
        v-model.number="frameDurationMs"
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
</template>

<style scoped>
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
