import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";

type ColormapChoiceShape = {
  id: string;
  label: string;
  colormapIndex: number;
  reversed: boolean;
};

/** Shortlist of colormap options appropriate for 2 m temperature. */
export const COLORMAP_CHOICES = [
  {
    id: "thermal",
    label: "thermal (cmocean sequential)",
    colormapIndex: COLORMAP_INDEX.thermal,
    reversed: false,
  },
  {
    id: "coolwarm",
    label: "coolwarm (diverging)",
    colormapIndex: COLORMAP_INDEX.coolwarm,
    reversed: false,
  },
  {
    id: "rdbu_r",
    label: "RdBu reversed (blue→red)",
    colormapIndex: COLORMAP_INDEX.rdbu,
    reversed: true,
  },
  {
    id: "balance",
    label: "balance (cmocean diverging)",
    colormapIndex: COLORMAP_INDEX.balance,
    reversed: false,
  },
  {
    id: "turbo",
    label: "turbo",
    colormapIndex: COLORMAP_INDEX.turbo,
    reversed: false,
  },
] as const satisfies readonly ColormapChoiceShape[];

export type ColormapId = (typeof COLORMAP_CHOICES)[number]["id"];
export type ColormapChoice = (typeof COLORMAP_CHOICES)[number];

export const DEFAULT_COLORMAP_ID: ColormapId = COLORMAP_CHOICES[0].id;
