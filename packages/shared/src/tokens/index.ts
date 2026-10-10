// `@m365portal/shared/tokens`: the design tokens, defined once (PD-13, FR-A-120). The web package maps
// them to Tailwind utilities through CSS variables; the accent test and the app import the very same
// surfaces from here (FR-A-102). One of the two barrels of the package (TA-05): the modules below are
// the only files that feed it.
export * from './colours.js';
export * from './css.js';
export * from './focus.js';
export * from './glass.js';
export * from './layers.js';
export * from './motion.js';
export * from './radius.js';
export * from './shadow.js';
export * from './spacing.js';
export * from './type.js';
