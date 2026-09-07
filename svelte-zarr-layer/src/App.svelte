<script lang="ts">
  import type { LoadingState } from "@carbonplan/zarr-layer";
  import { ZarrLayer } from "@carbonplan/zarr-layer";
  import { Map as MaplibreMap } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onMount } from "svelte";
  import { COOLWARM_COLORMAP, THERMAL_COLORMAP } from "./ecmwf/colormap.js";
  import { ECMWF_LEAD_TIME_COUNT, ECMWF_LEAD_TIME_STEP_HOURS } from "./ecmwf/metadata.js";
  import ControlPanel from "./lib/ControlPanel.svelte";

  const BASE_STEP_HOURS = 3;

  // Same public dataset used by the deck.gl-raster/dynamical-zarr-ecmwf demo,
  // fetched via the S3 path-style endpoint (the bucket name contains dots,
  // which breaks the TLS wildcard cert used by virtual-hosted-style URLs).
  const ZARR_URL =
    "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.zarr";
  const VARIABLE = "temperature_2m";
  const ENSEMBLE_MEMBER_IDX = 0; // control run
  const CLIM: [number, number] = [-40, 50]; // degree_Celsius, per the array's own units attr

  type ColormapId = "thermal" | "coolwarm";

  let mapContainer: HTMLDivElement;
  let map: MaplibreMap | undefined;
  let layer: ZarrLayer | undefined;

  let leadTimeIdx = $state(0);
  let initTimeIdx = $state(0);
  // @carbonplan/zarr-layer doesn't expose the opened array's shape back to
  // the caller (unlike zarrita, which the deck.gl-raster demo opens
  // directly), so the init_time count is fetched once, separately, straight
  // from the variable's own zarr.json -- no zarrita dependency needed for
  // that, since Zarr v3 array metadata is just plain JSON.
  let initTimeCount = $state(0);
  let isPlaying = $state(true);
  let colormapId = $state<ColormapId>("thermal");
  let opacity = $state(0.85);
  let frameDurationMs = $state(300);
  let statusMessage = $state("Loading layer metadata...");

  let colormap = $derived(
    colormapId === "thermal" ? THERMAL_COLORMAP : COOLWARM_COLORMAP,
  );

  function selectorFor(initIdx: number, leadIdx: number) {
    return {
      init_time: { selected: initIdx, type: "index" as const },
      lead_time: { selected: leadIdx, type: "index" as const },
      ensemble_member: { selected: ENSEMBLE_MEMBER_IDX, type: "index" as const },
    };
  }

  function handleLoadingStateChange(state: LoadingState) {
    if (state.error) {
      statusMessage = `Error: ${state.error.message}`;
    } else if (state.loading) {
      statusMessage = state.metadata ? "Loading metadata..." : "Loading tiles...";
    } else {
      statusMessage = "";
    }
  }

  onMount(() => {
    let cancelled = false;

    (async () => {
      try {
        const resp = await fetch(`${ZARR_URL}/${VARIABLE}/zarr.json`);
        const json = await resp.json();
        if (cancelled) return;
        initTimeCount = json.shape[0];
        initTimeIdx = initTimeCount - 1; // latest available forecast run
      } catch (err) {
        console.error("Failed to read init_time count:", err);
      }
    })();

    const newMap = new MaplibreMap({
      container: mapContainer,
      style: "https://demotiles.maplibre.org/style.json",
      center: [10, 45],
      zoom: 3.5,
    });
    map = newMap;

    newMap.on("load", () => {
      layer = new ZarrLayer({
        id: "ecmwf-zarr-layer",
        source: ZARR_URL,
        variable: VARIABLE,
        colormap: [...colormap],
        clim: CLIM,
        opacity,
        selector: selectorFor(initTimeIdx, leadTimeIdx),
        onLoadingStateChange: handleLoadingStateChange,
      });
      newMap.addLayer(layer);
    });

    return () => {
      cancelled = true;
      newMap.remove();
    };
  });

  // Push style-only changes (colormap/opacity) via the layer's own setters,
  // avoiding a full layer recreation.
  $effect(() => {
    if (!layer) return;
    layer.setColormap([...colormap]);
  });
  $effect(() => {
    if (!layer) return;
    layer.setOpacity(opacity);
  });

  // Selector changes trigger a fresh fetch on every call (no client-side
  // caching of "all frames" the way deck.gl-raster's Texture2DArray does),
  // so this is the one dependency worth debouncing on rapid slider drags —
  // here it's already gated by the animation loop's own dwell timing.
  $effect(() => {
    if (!layer) return;
    layer.setSelector(selectorFor(initTimeIdx, leadTimeIdx));
  });

  // Animation loop -- same lead-time dwell-scaling idea as the deck.gl-raster
  // demo, but with a much larger minimum interval: every tick here is a real
  // network fetch, not a texture-array index change.
  $effect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const curStepHours = ECMWF_LEAD_TIME_STEP_HOURS[leadTimeIdx] ?? BASE_STEP_HOURS;
      const dwell = frameDurationMs * (curStepHours / BASE_STEP_HOURS);
      if (now - last >= dwell) {
        leadTimeIdx = (leadTimeIdx + 1) % ECMWF_LEAD_TIME_COUNT;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="app">
  <div class="map" bind:this={mapContainer}></div>
  <ControlPanel
    {leadTimeIdx}
    {initTimeIdx}
    {initTimeCount}
    {isPlaying}
    {colormapId}
    {opacity}
    {frameDurationMs}
    {statusMessage}
    onLeadTimeIdxChange={(v) => (leadTimeIdx = v)}
    onInitTimeIdxChange={(v) => (initTimeIdx = v)}
    onPlayPauseToggle={() => (isPlaying = !isPlaying)}
    onColormapIdChange={(v) => (colormapId = v)}
    onOpacityChange={(v) => (opacity = v)}
    onFrameDurationMsChange={(v) => (frameDurationMs = v)}
  />
</div>

<style>
  .app {
    position: relative;
    width: 100vw;
    height: 100vh;
  }
  .map {
    position: absolute;
    inset: 0;
  }
</style>
