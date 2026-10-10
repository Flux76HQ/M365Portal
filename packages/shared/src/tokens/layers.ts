// Stacking layers (plan 10.3). Strictly ascending in the order written here; components take a
// z-index from this table and never write a number of their own.

export const Z_LAYERS = Object.freeze({
  base: 0,
  sticky: 10,
  chrome: 20,
  menu: 30,
  scrim: 40,
  dialog: 50,
  toast: 60,
  tooltip: 70,
} as const);

export type LayerName = keyof typeof Z_LAYERS;
