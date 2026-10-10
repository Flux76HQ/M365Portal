// Radius tokens (plan 10.3): 4, 6 and 8 px.

export const RADIUS_PX = Object.freeze({ sm: 4, md: 6, lg: 8 } as const);

/** A pill or circle. Only for the uses listed below; every other surface takes sm, md or lg. */
export const RADIUS_FULL_PX = 9999;

export const RADIUS_FULL_USES = Object.freeze(['avatar', 'switch-thumb', 'status-dot'] as const);
