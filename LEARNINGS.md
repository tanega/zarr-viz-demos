# GPU-accelerated Zarr visualization — learnings log

Exploring two stacks for visualizing large Zarr datasets on the GPU, each with
a Svelte + Vite frontend:

1. `svelte-deckgl-raster/` — [deck.gl-raster](https://github.com/developmentseed/deck.gl-raster)
   (`@developmentseed/deck.gl-raster` + `@developmentseed/deck.gl-zarr`),
   ported from the upstream React example
   [`examples/dynamical-zarr-ecmwf`](https://github.com/developmentseed/deck.gl-raster/tree/main/examples/dynamical-zarr-ecmwf).
2. `svelte-zarr-layer/` — [carbonplan/zarr-layer](https://github.com/carbonplan/zarr-layer)
   for MapLibre.

---

## 1. deck.gl-raster + Svelte

### Source data

- Dataset: ECMWF IFS ENS 15-day 0.25° ensemble forecast, hosted by
  [dynamical.org](https://dynamical.org/catalog/ecmwf-ifs-ens-forecast-15-day-0-25-degree/)
  on a public source.coop / S3 bucket.
- Zarr **v3**, with **consolidated metadata** (whole hierarchy inlined in the
  root `zarr.json`).
- Variable `temperature_2m`, dims `[init_time, lead_time, ensemble_member,
  latitude, longitude]`, dtype `float32`.
- `lead_time` is non-uniform: 3-hourly for 0–144h (48 steps), then 6-hourly
  to 360h (37 steps) — 85 steps total. Handled entirely client-side by a
  static schedule table (`ecmwf/metadata.ts`), not read from array metadata.
- The bucket name contains dots, which breaks the TLS wildcard cert used by
  virtual-hosted-style S3 URLs — must use the **path-style** endpoint
  (`https://s3.us-west-2.amazonaws.com/<bucket>/<key>`), not
  `https://<bucket>.s3.amazonaws.com/...` or the source.coop HTTP gateway
  (which no longer serves this store's original layout).

### Package shape (published, not just workspace-internal)

Despite the example's `package.json` listing `workspace:^` for the internal
packages, they *are* published standalone on npm and installable outside the
monorepo:

- `@developmentseed/deck.gl-raster` (0.7.0) — low-level: `RasterTileLayer`,
  GPU shader modules (`gpu-modules` subpath export), tileset/reprojection
  machinery. Framework-agnostic deck.gl layer.
- `@developmentseed/deck.gl-zarr` (0.7.0) — `ZarrLayer`, built on top of
  `RasterTileLayer` + `@developmentseed/geozarr`. Uses `zarrita` for store
  access, reprojects each Zarr chunk on the GPU into the Web Mercator
  viewport on the fly (no tile server needed).
- `@developmentseed/geozarr`, `@developmentseed/affine`, `@developmentseed/proj`
  — supporting packages, also published, pulled in transitively.
- Only `deck.gl-raster-examples-shared` (chakra-based UI kit + `DeckGlOverlay`
  React wrapper) is monorepo-internal and unpublished — irrelevant, since it's
  pure UI chrome we rewrote from scratch.
- `@developmentseed/deck.gl-raster/gpu-modules/colormaps.png` is a **subpath
  export** resolving to a real file; Vite (or any bundler resolving package
  `exports`) handles it as a normal asset import → URL string, no special
  config needed.

### Framework independence: the deck.gl/MapLibre integration is trivial to port

The single React-specific piece in the whole example is `DeckGlOverlay`:

```tsx
export function DeckGlOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}
```

`useControl` is just `react-map-gl`'s hook for "register this as a MapLibre
control." There is **no deck.gl-specific React dependency** — `MapboxOverlay`
from `@deck.gl/mapbox` is a plain MapLibre `IControl` implementation. Porting
to Svelte (or any framework) is exactly:

```ts
const overlay = new MapboxOverlay({ interleaved: true, layers: [], onDeviceInitialized });
map.addControl(overlay);
// later, on any state change:
overlay.setProps({ layers: [...] });
```

This generalizes: **any deck.gl + MapLibre/Mapbox example that uses
`react-map-gl` can be ported to a non-React framework by replacing
`useControl(() => new MapboxOverlay(props))` + a `setProps` effect with a
plain `map.addControl()` call once, and `overlay.setProps()` wherever the
React version would re-render.** No deck.gl React bindings are needed at all
for this pattern (contrast with `@deck.gl/react`'s `<DeckGL>` component,
which *is* React-specific — this example avoids it by using the MapLibre
overlay control instead).

### Svelte 5 runes map cleanly onto the React hooks in this example

| React (original) | Svelte 5 (port) |
|---|---|
| `useState` | `$state` |
| `useMemo` | `$derived` |
| `useEffect(fn, [deps])` | `$effect(fn)` — Svelte auto-tracks read dependencies, no dep array to get wrong |
| `useCallback` + manual `updateTriggers` array on the layer | a single `$effect` that reads every prop the layer needs and calls `overlay.setProps({ layers: [...] })` — deck.gl's own prop-diffing (layer `id` + prop equality) still decides what actually re-renders on the GPU side |
| `useRef` (for the RAF loop reading latest `leadTimeIdx` without resubscribing) | not needed — a Svelte `$state` variable read inside a plain closure always reads the live value, no stale-closure risk the way a raw JS closure over a `let` would have in React |

One real gotcha: deck.gl's `RasterTileLayer`/`ZarrLayer` `updateTriggers`
prop still needs to be set explicitly (it's a deck.gl-level cache-invalidation
mechanism for the `renderTile` GPU pipeline, independent of Svelte's own
reactivity) — Svelte reactivity decides *when the effect re-runs and builds a
new layer instance*, but `updateTriggers` decides whether deck.gl treats the
new layer instance's `renderTile` as producing different output for tiles it
already has cached. Both layers of "is this actually different" have to be
correct.

### The render pipeline (GPU-side compositing)

`renderTile(data)` returns a `RenderPipeline`: an ordered list of shader
modules, each contributing a `fs:DECKGL_FILTER_COLOR` injection that mutates
`color` in place. For this example:

1. `SampleTexture2DArray` (custom, in `gpu/`) — samples a `sampler2DArray`
   r32float texture at `(uv, layerIndex)` where `layerIndex` = animation
   frame (`lead_time` index); discards NaN (nodata) texels.
2. `FilterRange` (custom, in `gpu/`) — discards fragments whose raw scalar
   falls outside a user-controlled `[filterMin, filterMax]` window. Runs
   *before* rescale, i.e. on the raw physical-unit value, not the normalized
   one.
3. `LinearRescale` (from `deck.gl-raster/gpu-modules`) — maps
   `[rescaleMin, rescaleMax]` → `[0, 1]`.
4. `Colormap` (from `deck.gl-raster/gpu-modules`) — samples a colormap sprite
   texture (`colormaps.png`, decoded once via `decodeColormapSprite` into
   `ImageData`, then uploaded via `createColormapTexture(device, image)`) at
   the rescaled value.

Each tile's raw data is uploaded as a single `Texture2DArray` covering **all
85 lead_time frames at once** (`depth: ECMWF_LEAD_TIME_COUNT`), not one
texture per frame. Animation is then just changing the `layerIndex` uniform
— zero re-fetching, zero re-uploading per frame. This is the key GPU trick
that makes smooth 85-frame animation possible without hammering the network
or re-encoding data every tick.

### GeoZarr metadata is often synthetic

The dynamical.org store is **not** GeoZarr-compliant. The example hardcodes
a `GeoZarrMetadata`-shaped object (`ECMWF_GEOZARR_ATTRS`) — spatial
dimension names, an affine transform, shape, and CRS — and passes it via the
layer's `metadata` prop instead of relying on `group.attrs`. Worth
remembering: `ZarrLayer` will happily accept caller-supplied metadata for any
store that doesn't publish the convention itself, as long as you know the
grid geometry out of band.

### Zarr v2 vs v3 note (relevant to the spec reading also requested)

The example forces `zarr.open.v3(...)` and `withConsolidatedMetadata(...,
{format: "v3"})` explicitly rather than letting zarrita auto-detect, "so
auto-detection doesn't silently fall back to v2." Zarr v3's `zarr.json`
consolidates the whole store's metadata tree in one file at the root
(one HTTP request to discover the full hierarchy), whereas v2's
`.zmetadata` convention is an optional, separately-specified add-on with a
different key layout (flat dict of `path/.zarray` or `path/.zattrs` keys) —
the two consolidation formats are not wire-compatible, hence forcing the
version explicitly instead of relying on sniffing.

### Svelte-port-specific fixes needed over a naive line-for-line port

- `maplibre-gl` must be pinned to **v5** (`^5.24.0`, matching the upstream
  React example's own version), not v6 — `@deck.gl/mapbox`'s `MapboxOverlay`
  does not yet integrate with maplibre-gl v6 (confirmed independently in a
  parallel session). `npm install maplibre-gl` on its own resolves to v6
  since that's now the default `latest` tag; this has to be pinned
  explicitly (`npm install maplibre-gl@5.24.0`) rather than left to auto-
  resolve. This constraint is specific to the deck.gl integration —
  `svelte-zarr-layer/` doesn't go through deck.gl at all and stays on
  maplibre-gl v6 without issue (its `ZarrLayer` only declares `"maplibre-gl":
  "*"` as an optional peer).
- Both v5 and v6's ESM builds have **no default export** — must use
  `import { Map as MaplibreMap } from "maplibre-gl"` (the React example's
  `react-map-gl` wrapper hides this either way).
- `ZarrLayer`'s `onTileUnload` prop type is inherited via `Pick<TileLayerProps,
  "onTileUnload">` from `@deck.gl/geo-layers`, and bare `TileLayerProps`
  defaults its `DataT` generic to `unknown` — so `tile.content` types as
  `unknown` regardless of the `DataT` you pass to `ZarrLayer<Store, Dtype,
  DataT>` at the call site. This looks like an upstream type-plumbing gap;
  worked around with an explicit cast (`tile.content as EcmwfTileData |
  null`) rather than fighting the types.
- `beforeId` (layer z-order relative to specific basemap style layers) is a
  real runtime prop injected by `@deck.gl/mapbox`, but isn't part of the
  declared `LayerProps` type — needs a `@ts-expect-error` at the call site
  in both the original and the port.

### Structure of the port (`svelte-deckgl-raster/`)

```
src/
  ecmwf/            # framework-agnostic — ported verbatim from the React example
    metadata.ts       lead-time schedule, init-time date math, hardcoded GeoZarr attrs
    selection.ts       builds the ZarrLayer `selection` (pin init_time + ensemble_member)
    colormap-choices.ts
    get-tile-data.ts   zarr.get() -> Texture2DArray upload
    render-tile.ts     builds the 4-module GPU render pipeline
  gpu/              # framework-agnostic — custom luma.gl shader modules
    filter-range.ts
    sample-texture-2d-array.ts
  lib/
    ControlPanel.svelte   plain HTML controls (no chakra), Svelte 5 runes props
  App.svelte          MapLibre map + MapboxOverlay wiring, all reactive state, one
                       $effect that (re)builds the ZarrLayer and pushes it via
                       overlay.setProps()
  map-style.json     copied as-is from the upstream example (Carto Dark Matter,
                     water layers stripped)
```

Everything under `ecmwf/` and `gpu/` needed **zero changes** to port — the
React example was already careful to keep all data/GPU logic framework-free
and push all React-specific code into `App.tsx` + `ui/control-panel.tsx`.

### Verification status

- `svelte-check` (full project, Svelte 5 + TS): **0 errors, 0 warnings**.
- Dev server boots cleanly, all key modules (`/src/main.ts`, `/src/App.svelte`)
  transform without error under Vite.
- The zarr store's HTTP endpoint was confirmed reachable (200, CORS-public S3
  bucket).
- **Not yet done**: actual in-browser runtime verification (WebGL render,
  animation, zarr fetch success) — no Chrome automation was available this
  session. Run `npm run dev` in `svelte-deckgl-raster/` and check manually
  before treating this as fully working.

---

## 2. carbonplan/zarr-layer + Svelte (MapLibre)

### API shape: a MapLibre `CustomLayerInterface`, not a deck.gl layer

`ZarrLayer` from `@carbonplan/zarr-layer` implements MapLibre/Mapbox's
[`CustomLayerInterface`](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)
directly and is added with plain `map.addLayer(layer, beforeId?)` — there is
no deck.gl, no overlay control, no `RenderTileResult`/shader-module
composition to write. Compared to deck.gl-raster's split (`getTileData` +
`renderTile` callbacks the caller must implement), zarr-layer is a
batteries-included, high-level component: you hand it `source`, `variable`,
`colormap` (a plain array of hex strings — no sprite texture, no GPU decode
step), `clim` (rescale range) and a `selector`, and it owns tiling, fetch,
decode and render internally.

```ts
import { ZarrLayer } from "@carbonplan/zarr-layer";
const layer = new ZarrLayer({ id, source, variable, colormap, clim, selector });
map.addLayer(layer);
// later:
layer.setSelector({ time: { selected: 3, type: "index" } });
layer.setColormap([...]);
layer.setClim([min, max]);
layer.setOpacity(0.8);
```

This is **framework-agnostic by construction** — the upstream demo's own
`Map` component and `useMapLayer` hook (React) are pure wiring around
`map.addLayer` / `layer.setSelector` calls in `useEffect`s; porting to Svelte
is the same pattern as `svelte-deckgl-raster`: replace `useEffect(fn, deps)`
with `$effect(fn)` and let Svelte's fine-grained reactivity do the dependency
tracking.

### No caller-supplied geospatial metadata needed for this dataset

This is the sharpest contrast with the deck.gl-raster port. The ECMWF store
is *not* GeoZarr-compliant (no `spatial`/`proj` convention attrs), so
deck.gl-zarr's `ZarrLayer` required a hand-written, synthetic
`ECMWF_GEOZARR_ATTRS` object (affine transform, shape, CRS) passed via its
`metadata` prop. `@carbonplan/zarr-layer`, when a store doesn't publish the
`spatial`/`proj` conventions, instead **falls back to reading the actual
coordinate arrays** (`latitude`, `longitude` — confirmed present as sibling
arrays in this store's consolidated metadata) for extent and orientation,
matches dimension names against a list of common aliases, and infers
EPSG:4326 vs EPSG:3857 from the magnitude of the bounds it reads. Net effect:
**zero geospatial configuration** was needed for the ECMWF dataset in this
port — no `bounds`, `crs`, `proj4`, or `spatialDimensions` override. Only
`clim: [-40, 50]` (the variable's own `units: degree_Celsius` attribute,
confirmed via the array's `zarr.json`) needed a caller-supplied value, since
"what color range to render at" isn't something any Zarr convention encodes.

### Selector model: per-call fetch, not a preloaded frame buffer

This is the other sharp contrast, and the one with real performance
consequences for animation. deck.gl-raster's `getTileData` in the ECMWF demo
uploads **all 85 lead_time frames per spatial chunk as one `Texture2DArray`**
up front; animating is just changing a `layerIndex` uniform — zero
network/GPU-upload cost per frame after the initial load.

`@carbonplan/zarr-layer`'s `layer.setSelector(...)` has no such buffering: it
kicks off a fresh Zarr chunk fetch (and re-render) **every time it's
called** — the README's own docs call this out explicitly ("For UIs that
fire rapid updates... debounce the value on your side"). Porting the same
85-frame smooth animation loop verbatim would fire one HTTP request per
frame at the original demo's 100 ms cadence. The Svelte port keeps the same
lead-time dwell-scaling logic (`ECMWF_LEAD_TIME_STEP_HOURS`) but raises the
default minimum frame interval to 300 ms (user-adjustable down to 150 ms) and
calls this tradeoff out in the UI copy, rather than pretending it's the same
kind of animation.

### Getting the init_time count without zarrita

`ZarrLayer` doesn't expose the zarrita array/group it opens internally back
to the caller (contrast with deck.gl-zarr's example, which has the caller
open the `zarr.Array` itself and can read `.shape` directly). To build a
date-range-bounded picker without adding a `zarrita` dependency to this
demo, the port fetches the variable's own Zarr v3 `zarr.json` directly
(`${ZARR_URL}/${VARIABLE}/zarr.json`) and reads `.shape[0]` — valid because
v3 array metadata is just plain JSON with no framing, so this needs nothing
more than `fetch()` + `.json()`. This is a Zarr-v3-specific shortcut: it
would not work as directly against a v2 store's `.zarray`, though that's
also plain JSON so the same trick still applies almost unchanged.

### Structure of the port (`svelte-zarr-layer/`)

```
src/
  ecmwf/
    metadata.ts      identical copy of the deck.gl-raster port's file — lead-time
                      schedule and init-time date math are dataset properties, not
                      library-specific, so this ports byte-for-byte between the two demos
    colormap.ts       two small hex-string colormap arrays (thermal, coolwarm)
  lib/
    ControlPanel.svelte   date picker, lead-time slider + play/pause, colormap select,
                          opacity, and a "min frame interval" slider (absent from the
                          deck.gl-raster demo, since that one has no equivalent cost)
  App.svelte          MapLibre map + ZarrLayer wiring; $effects push selector/colormap/
                       opacity changes via the layer's own setters instead of recreating it
```

Basemap: MapLibre's public `demotiles.maplibre.org/style.json` (no API key,
minimal vector style) — the upstream zarr-layer demo uses a heavier
protomaps/pmtiles + custom dark theme setup that wasn't worth reproducing for
a minimal comparison SPA.

### Verification status

- `svelte-check` (full project, Svelte 5 + TS): **0 errors, 0 warnings**.
- Dev server boots cleanly, key modules transform without error under Vite.
- Confirmed via direct `zarr.json` fetch: `temperature_2m` shape is
  `[890, 85, 51, 721, 1440]` (`init_time, lead_time, ensemble_member,
  latitude, longitude`), `units: "degree_Celsius"`, and `latitude`/
  `longitude` exist as sibling coordinate arrays in the store's consolidated
  metadata — confirming the "no manual geospatial config needed" claim above
  against the actual store rather than just the library's README.
- **Not yet done**: actual in-browser runtime verification — same
  limitation as the deck.gl-raster port (no Chrome automation available this
  session). Run `npm run dev` in `svelte-zarr-layer/` and check manually.

### Head-to-head summary

| | deck.gl-raster (`@developmentseed/deck.gl-zarr`) | zarr-layer (`@carbonplan/zarr-layer`) |
|---|---|---|
| Map integration | `MapboxOverlay` (deck.gl) added as a MapLibre control | `ZarrLayer` itself *is* a MapLibre `CustomLayerInterface` |
| Rendering pipeline | caller composes GPU shader modules (`renderTile`) | built-in; `customFrag`/`uniforms` escape hatch only if needed |
| Data fetch | caller writes `getTileData` (raw `zarr.get` + texture upload) | built-in; caller never touches zarrita directly |
| GeoZarr metadata | needed synthetic `metadata` override for this non-compliant store | none needed — falls back to reading coordinate arrays directly |
| Colormap | sprite PNG decoded to `ImageData`, uploaded as a GPU texture | plain hex-string array |
| Animation cost | one texture upload per chunk covering *all* frames; per-frame cost is a uniform change | one fetch + render per `setSelector()` call — no frame buffering |
| Lines of app-specific code needed | more (own shader modules, texture upload, render pipeline) | less (declarative options + a few setters) |
| What you give up for the simplicity | fine-grained GPU control (custom filter/rescale/colormap composition) | `customFrag` covers most of the same ground, but animating many frames smoothly needs work-arounds zarr-layer doesn't provide out of the box |

---

## Zarr spec notes (v2 vs v3), for reference

- **v2** (https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html): each
  array is `.zarray` (dtype, shape, chunks, compressor, fill_value, order,
  filters) + chunk keys named `i.j.k` (dot-separated by default); each group
  is `.zgroup` + optional `.zattrs`. No mandatory consolidated metadata;
  `.zmetadata` is a convention bolted on later (flat JSON mapping every
  `.zarray`/`.zattrs`/`.zgroup` path to its contents, so a store can be
  fully introspected in one request).
- **v3** (https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html):
  unifies groups and arrays under a single `zarr.json` per node (with a
  `node_type` field), adds explicit `codecs` (replacing v2's
  compressor+filters split), and standardizes **chunk key encoding**
  (`c/0/0/0` "default" separator vs `c0.0.0` "v2-style" — configurable per
  array). Consolidated metadata is a first-class, spec-named feature
  (inlined under `zarr.json`'s `consolidated_metadata` key at the root),
  not a bolted-on convention — which is why zarrita's
  `withConsolidatedMetadata(..., {format: "v3"})` and `.zarray`-style v2
  consolidation are handled by genuinely different code paths.
