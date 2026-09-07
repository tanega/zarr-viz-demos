/**
 * Small hand-picked thermal-style hex colormap for 2 m temperature.
 * @carbonplan/zarr-layer's `colormap` option is just a plain array of hex
 * strings (or `[r,g,b]` tuples) sampled as a 1D gradient — no sprite texture
 * or GPU decode step required, unlike deck.gl-raster's colormap sprite.
 */
export const THERMAL_COLORMAP: readonly string[] = [
  "#042333",
  "#2c3395",
  "#744992",
  "#b15f82",
  "#eb7958",
  "#fbb43d",
  "#e8fa5b",
];

export const COOLWARM_COLORMAP: readonly string[] = [
  "#3b4cc0",
  "#7396f5",
  "#b8c0ff",
  "#dddddd",
  "#f6b69d",
  "#e2604f",
  "#b40426",
];
