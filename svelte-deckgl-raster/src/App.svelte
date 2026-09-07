<script lang="ts">
  import { MapboxOverlay } from "@deck.gl/mapbox";
  import {
    createColormapTexture,
    decodeColormapSprite,
  } from "@developmentseed/deck.gl-raster/gpu-modules";
  import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
  import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
  import type { Device, Texture } from "@luma.gl/core";
  import { Map as MaplibreMap, type IControl, type StyleSpecification } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onMount } from "svelte";
  import * as zarr from "zarrita";
  import {
    COLORMAP_CHOICES,
    DEFAULT_COLORMAP_ID,
    type ColormapId,
  } from "./ecmwf/colormap-choices.js";
  import type { EcmwfTileData } from "./ecmwf/get-tile-data.js";
  import { getTileData } from "./ecmwf/get-tile-data.js";
  import {
    ECMWF_GEOZARR_ATTRS,
    ECMWF_LEAD_TIME_COUNT,
    ECMWF_LEAD_TIME_STEP_HOURS,
  } from "./ecmwf/metadata.js";
  import { makeRenderTile } from "./ecmwf/render-tile.js";
  import { buildSelection } from "./ecmwf/selection.js";
  import ControlPanel from "./lib/ControlPanel.svelte";
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

  let mapContainer: HTMLDivElement;
  let overlay: MapboxOverlay | undefined;

  let leadTimeIdx = $state(0);
  let initTimeIdx = $state(0);
  let isPlaying = $state(true);
  let arr = $state<zarr.Array<"float32", zarr.Readable> | null>(null);
  let initTimeCount = $derived(arr ? arr.shape[0]! : 0);
  let colormapId = $state<ColormapId>(DEFAULT_COLORMAP_ID);
  let rescaleMin = $state(INITIAL_RESCALE_MIN);
  let rescaleMax = $state(INITIAL_RESCALE_MAX);
  // Filter range is independent of rescale; starts wide open.
  let filterMin = $state(INITIAL_RESCALE_MIN);
  let filterMax = $state(INITIAL_RESCALE_MAX);
  let frameDurationMs = $state(INITIAL_FRAME_DURATION_MS);

  let colormapChoice = $derived(
    COLORMAP_CHOICES.find((c) => c.id === colormapId) ?? COLORMAP_CHOICES[0],
  );

  let colormapImage = $state<ImageData | null>(null);
  let device = $state<Device | null>(null);
  let colormapTexture = $state<Texture | null>(null);
  let statusMessage = $state("Opening Zarr store...");

  onMount(() => {
    const map = new MaplibreMap({
      container: mapContainer,
      // Custom style that removes water layers from the basemap.
      style: mapStyle as StyleSpecification,
      center: [10, 45],
      zoom: 4.5,
    });

    overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onDeviceInitialized: (d: Device) => {
        device = d;
      },
    });
    map.addControl(overlay as unknown as IControl);

    // Decode the shipped colormap sprite once at mount. Returns ImageData
    // and doesn't need a GPU device, so it can run in parallel with zarr
    // opening.
    let cancelled = false;
    (async () => {
      const resp = await fetch(colormapsPngUrl as string);
      const bytes = await resp.arrayBuffer();
      const image = await decodeColormapSprite(bytes);
      if (cancelled) return;
      colormapImage = image;
    })();

    // Open the Zarr store + variable once. The Dynamical.org ECMWF store
    // uses Zarr v3 with consolidated metadata (the full hierarchy is
    // inlined in the root zarr.json). Both are forced explicitly so
    // auto-detection doesn't silently fall back to v2.
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
        arr = opened;
        // Default to the latest available forecast run.
        initTimeIdx = opened.shape[0]! - 1;
        statusMessage = "";
      } catch (err) {
        console.error(err);
        statusMessage = `Failed to open Zarr store: ${(err as Error).message}`;
      }
    })();

    return () => {
      cancelled = true;
      map.remove();
    };
  });

  // Upload the colormap sprite once the luma.gl Device is available. The
  // Device arrives via the overlay's onDeviceInitialized callback; the
  // sprite was decoded asynchronously above. $effect re-runs whenever
  // either dependency changes, mirroring the React useEffect([device, image]).
  $effect(() => {
    if (!device || !colormapImage) return;
    colormapTexture = createColormapTexture(device, colormapImage);
  });

  // Animation loop: advance leadTimeIdx at a rate proportional to each
  // frame's lead-time step, so a 3h step dwells for frameDurationMs and a
  // 6h step dwells for 2x that. Uses requestAnimationFrame so it auto-pauses
  // when the tab is hidden.
  $effect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const curStepHours =
        ECMWF_LEAD_TIME_STEP_HOURS[leadTimeIdx] ?? BASE_STEP_HOURS;
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

  // Rebuild the ZarrLayer + push it to the overlay whenever any tracked
  // dependency changes. This $effect plays the role of React's useMemo
  // (layers), useCallback (renderTile) and updateTriggers combined: Svelte's
  // fine-grained reactivity tracks exactly which state was read.
  $effect(() => {
    if (!overlay) return;
    if (!arr || !colormapTexture) {
      overlay.setProps({ layers: [] });
      return;
    }

    const selection = buildSelection({
      initTimeIdx,
      ensembleMemberIdx: ENSEMBLE_MEMBER_IDX,
    });

    const renderTile = makeRenderTile({
      layerIndex: leadTimeIdx,
      colormapTexture,
      colormapIndex: colormapChoice.colormapIndex,
      colormapReversed: colormapChoice.reversed,
      filterMin,
      filterMax,
      rescaleMin,
      rescaleMax,
    });

    const layer = new ZarrLayer<zarr.Readable, "float32", EcmwfTileData>({
      // Include initTimeIdx in the id so switching init_time discards
      // cached tiles from the previous forecast run.
      id: `ecmwf-zarr-layer-${initTimeIdx}`,
      node: arr,
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
          leadTimeIdx,
          colormapId,
          rescaleMin,
          rescaleMax,
          filterMin,
          filterMax,
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

<div class="app">
  <div class="map" bind:this={mapContainer}></div>
  {#if statusMessage}
    <div class="status">{statusMessage}</div>
  {/if}
  <ControlPanel
    {leadTimeIdx}
    {initTimeIdx}
    {initTimeCount}
    {isPlaying}
    {colormapId}
    {rescaleMin}
    {rescaleMax}
    {filterMin}
    {filterMax}
    {frameDurationMs}
    onLeadTimeIdxChange={(v) => (leadTimeIdx = v)}
    onInitTimeIdxChange={(v) => (initTimeIdx = v)}
    onPlayPauseToggle={() => (isPlaying = !isPlaying)}
    onColormapIdChange={(v) => (colormapId = v)}
    onRescaleMinChange={(v) => (rescaleMin = v)}
    onRescaleMaxChange={(v) => (rescaleMax = v)}
    onFilterMinChange={(v) => (filterMin = v)}
    onFilterMaxChange={(v) => (filterMax = v)}
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
