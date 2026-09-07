<script setup lang="ts">
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import type { Device, Texture } from "@luma.gl/core";
import {
  Map as MaplibreMap,
  type IControl,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { computed, onMounted, onUnmounted, ref, shallowRef, watchEffect } from "vue";
import * as zarr from "zarrita";
import ControlPanel from "./components/ControlPanel.vue";
import {
  COLORMAP_CHOICES,
  DEFAULT_COLORMAP_ID,
  type ColormapId,
} from "./ecmwf/colormap-choices";
import type { EcmwfTileData } from "./ecmwf/get-tile-data";
import { getTileData } from "./ecmwf/get-tile-data";
import {
  ECMWF_GEOZARR_ATTRS,
  ECMWF_LEAD_TIME_COUNT,
  ECMWF_LEAD_TIME_STEP_HOURS,
} from "./ecmwf/metadata";
import { makeRenderTile } from "./ecmwf/render-tile";
import { buildSelection } from "./ecmwf/selection";
import mapStyle from "./map-style.json";

/** Base step (hours) that `frameDurationMs` applies to. 3-hour steps dwell
 *  for `frameDurationMs`; 6-hour steps dwell for 2x that. */
const BASE_STEP_HOURS = 3;

// Fetched straight from the source.coop S3 bucket via the path-style S3
// endpoint. Path-style is required because the bucket name contains dots,
// which break the TLS wildcard cert used by virtual-hosted-style URLs.
const ZARR_URL =
  "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.zarr";

const VARIABLE = "temperature_2m";
const ENSEMBLE_MEMBER_IDX = 0; // control run
const INITIAL_RESCALE_MIN = -40; // C
const INITIAL_RESCALE_MAX = 50; // C
const INITIAL_FRAME_DURATION_MS = 100;

const mapContainer = ref<HTMLDivElement | null>(null);
// Not a ref: deck.gl/maplibre control instances are opaque host objects we
// only ever replace-as-a-whole via .setProps(), never read reactively.
let overlay: MapboxOverlay | undefined;

const leadTimeIdx = ref(0);
const initTimeIdx = ref(0);
const isPlaying = ref(true);
// shallowRef, not ref: these wrap opaque GPU/zarrita host objects
// (zarr.Array, luma.gl Device/Texture, ImageData). Vue's plain `ref()` would
// deep-proxy their contents, which is pointless (we only ever swap the
// whole reference) and risks confusing code that expects real object
// identity/prototype behavior from a WebGL-backed object.
const arr = shallowRef<zarr.Array<"float32", zarr.Readable> | null>(null);
const colormapId = ref<ColormapId>(DEFAULT_COLORMAP_ID);
const rescaleMin = ref(INITIAL_RESCALE_MIN);
const rescaleMax = ref(INITIAL_RESCALE_MAX);
// Filter range is independent of rescale; starts wide open.
const filterMin = ref(INITIAL_RESCALE_MIN);
const filterMax = ref(INITIAL_RESCALE_MAX);
const frameDurationMs = ref(INITIAL_FRAME_DURATION_MS);

const colormapImage = shallowRef<ImageData | null>(null);
const device = shallowRef<Device | null>(null);
const colormapTexture = shallowRef<Texture | null>(null);
const statusMessage = ref("Opening Zarr store...");

const initTimeCount = computed(() => (arr.value ? arr.value.shape[0]! : 0));
const colormapChoice = computed(
  () =>
    COLORMAP_CHOICES.find((c) => c.id === colormapId.value) ??
    COLORMAP_CHOICES[0],
);

let cancelled = false;
let mapInstance: MaplibreMap | undefined;

onMounted(() => {
  const map = new MaplibreMap({
    container: mapContainer.value!,
    // Custom style that removes water layers from the basemap.
    style: mapStyle as StyleSpecification,
    center: [10, 45],
    zoom: 4.5,
  });
  mapInstance = map;

  overlay = new MapboxOverlay({
    interleaved: true,
    layers: [],
    onDeviceInitialized: (d: Device) => {
      device.value = d;
    },
  });
  map.addControl(overlay as unknown as IControl);

  // Decode the shipped colormap sprite once at mount. Returns ImageData and
  // doesn't need a GPU device, so it can run in parallel with zarr opening.
  (async () => {
    const resp = await fetch(colormapsPngUrl as string);
    const bytes = await resp.arrayBuffer();
    const image = await decodeColormapSprite(bytes);
    if (cancelled) return;
    colormapImage.value = image;
  })();

  // Open the Zarr store + variable once. The Dynamical.org ECMWF store uses
  // Zarr v3 with consolidated metadata (the full hierarchy is inlined in
  // the root zarr.json). Both are forced explicitly so auto-detection
  // doesn't silently fall back to v2.
  (async () => {
    try {
      const store = await zarr.withConsolidatedMetadata(
        new zarr.FetchStore(ZARR_URL),
        { format: "v3" },
      );
      const root = await zarr.open.v3(store, { kind: "group" });
      const opened = await zarr.open.v3(root.resolve(VARIABLE), {
        kind: "array",
      });
      if (!opened.is("float32")) {
        throw new Error(
          `Expected ${VARIABLE} to be float32, got ${opened.dtype}`,
        );
      }
      if (cancelled) return;
      arr.value = opened;
      // Default to the latest available forecast run.
      initTimeIdx.value = opened.shape[0]! - 1;
      statusMessage.value = "";
    } catch (err) {
      console.error(err);
      statusMessage.value = `Failed to open Zarr store: ${(err as Error).message}`;
    }
  })();
});

onUnmounted(() => {
  cancelled = true;
  mapInstance?.remove();
});

// Upload the colormap sprite once the luma.gl Device is available. The
// Device arrives via the overlay's onDeviceInitialized callback; the sprite
// was decoded asynchronously above. watchEffect re-runs whenever either
// .value is read-and-changed, mirroring the Svelte port's $effect (and the
// original React useEffect([device, image])).
watchEffect(() => {
  if (!device.value || !colormapImage.value) return;
  colormapTexture.value = createColormapTexture(
    device.value,
    colormapImage.value,
  );
});

// Animation loop: advance leadTimeIdx at a rate proportional to each
// frame's lead-time step, so a 3h step dwells for frameDurationMs and a 6h
// step dwells for 2x that. Uses requestAnimationFrame so it auto-pauses
// when the tab is hidden. `onCleanup` is Vue's equivalent of returning a
// cleanup function from a Svelte $effect / React useEffect — it runs both
// when a tracked dependency changes and on unmount.
watchEffect((onCleanup) => {
  if (!isPlaying.value) return;
  let raf = 0;
  let last = performance.now();
  const loop = (now: number) => {
    const curStepHours =
      ECMWF_LEAD_TIME_STEP_HOURS[leadTimeIdx.value] ?? BASE_STEP_HOURS;
    const dwell = frameDurationMs.value * (curStepHours / BASE_STEP_HOURS);
    if (now - last >= dwell) {
      leadTimeIdx.value = (leadTimeIdx.value + 1) % ECMWF_LEAD_TIME_COUNT;
      last = now;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onCleanup(() => cancelAnimationFrame(raf));
});

// Rebuild the ZarrLayer + push it to the overlay whenever any tracked
// dependency changes. Vue's watchEffect auto-tracks every .value read
// synchronously in its body, the same auto-dependency-tracking Svelte's
// $effect does -- no dependency array to get wrong, unlike React's
// useEffect/useMemo/useCallback + manual updateTriggers combination the
// original example needed.
watchEffect(() => {
  if (!overlay) return;
  if (!arr.value || !colormapTexture.value) {
    overlay.setProps({ layers: [] });
    return;
  }

  const selection = buildSelection({
    initTimeIdx: initTimeIdx.value,
    ensembleMemberIdx: ENSEMBLE_MEMBER_IDX,
  });

  const renderTile = makeRenderTile({
    layerIndex: leadTimeIdx.value,
    colormapTexture: colormapTexture.value,
    colormapIndex: colormapChoice.value.colormapIndex,
    colormapReversed: colormapChoice.value.reversed,
    filterMin: filterMin.value,
    filterMax: filterMax.value,
    rescaleMin: rescaleMin.value,
    rescaleMax: rescaleMax.value,
  });

  const layer = new ZarrLayer<zarr.Readable, "float32", EcmwfTileData>({
    // Include initTimeIdx in the id so switching init_time discards cached
    // tiles from the previous forecast run.
    id: `ecmwf-zarr-layer-${initTimeIdx.value}`,
    node: arr.value,
    metadata: ECMWF_GEOZARR_ATTRS,
    selection,
    getTileData,
    renderTile,
    // The library's onTileUnload prop type is inherited from deck.gl's
    // TileLayerProps with its default (unknown) DataT, so `content` needs
    // an explicit cast back to what our own getTileData actually returns.
    onTileUnload: (tile) =>
      (tile.content as EcmwfTileData | null)?.texture.destroy(),
    // Tiles are heavy, so limit GPU pressure with a small cache size.
    maxCacheSize: 10,
    updateTriggers: {
      renderTile: [
        leadTimeIdx.value,
        colormapId.value,
        rescaleMin.value,
        rescaleMax.value,
        filterMin.value,
        filterMax.value,
      ],
    },
    // @ts-expect-error -- beforeId is injected by @deck.gl/mapbox to control
    // layer insertion order relative to the basemap's own layers; the base
    // LayerProps type doesn't know about it.
    beforeId: "boundary_county",
  });

  overlay.setProps({ layers: [layer] });
});
</script>

<template>
  <div class="app">
    <div class="map" ref="mapContainer"></div>
    <div v-if="statusMessage" class="status">{{ statusMessage }}</div>
    <ControlPanel
      v-model:lead-time-idx="leadTimeIdx"
      v-model:init-time-idx="initTimeIdx"
      v-model:colormap-id="colormapId"
      v-model:rescale-min="rescaleMin"
      v-model:rescale-max="rescaleMax"
      v-model:filter-min="filterMin"
      v-model:filter-max="filterMax"
      v-model:frame-duration-ms="frameDurationMs"
      :init-time-count="initTimeCount"
      :is-playing="isPlaying"
      @play-pause-toggle="isPlaying = !isPlaying"
    />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  width: 100vw;
  height: 100vh;
}
.map {
  position: absolute;
  inset: 0;
}
.status {
  position: absolute;
  top: 12px;
  left: 12px;
  background: rgba(20, 20, 20, 0.85);
  color: #eee;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}
</style>
