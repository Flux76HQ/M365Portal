// The feature bundle LazyMotion loads on demand (motion-provider.tsx). It sits in a module of its own
// that nothing imports statically, so the bundler puts domAnimation (animations, variants, exit
// animations, tap and hover gestures; no layout or drag) into a separate chunk instead of the entry
// chunk (plan 9.3). The default export is what LazyMotion expects from a dynamic import.
export { domAnimation as default } from 'motion/react';
