// The shared branding code the pickers need at run time: the accent derivation, the contrast maths and
// the token constants. They are imported lazily (plan 9.3, T-A-211): the Appearance route chunk loads them
// the first time a picker mounts, the entry chunk never does. `useBrandingTools()` is null until then, so
// a component renders its frame first and its derived parts once the tools are there.
import { useEffect, useState } from 'react';

export interface BrandingTools {
  readonly accent: typeof import('@m365portal/shared/branding/accent');
  readonly contrast: typeof import('@m365portal/shared/branding/contrast');
  readonly logoPlate: typeof import('@m365portal/shared/branding/logo-plate');
  readonly monogram: typeof import('@m365portal/shared/branding/monogram');
  readonly orgName: typeof import('@m365portal/shared/branding/org-name');
  readonly tokens: typeof import('@m365portal/shared/tokens');
}

let pending: Promise<BrandingTools> | undefined;
let loaded: BrandingTools | null = null;

/** Loads the tools once; every caller shares the same promise. */
export function loadBrandingTools(): Promise<BrandingTools> {
  pending ??= Promise.all([
    import('@m365portal/shared/branding/accent'),
    import('@m365portal/shared/branding/contrast'),
    import('@m365portal/shared/branding/logo-plate'),
    import('@m365portal/shared/branding/monogram'),
    import('@m365portal/shared/branding/org-name'),
    import('@m365portal/shared/tokens'),
  ]).then(([accent, contrast, logoPlate, monogram, orgName, tokens]) => {
    loaded = { accent, contrast, logoPlate, monogram, orgName, tokens };
    return loaded;
  });
  return pending;
}

/** The tools, or null while they load. Already-loaded tools are returned on the first render. */
export function useBrandingTools(): BrandingTools | null {
  const [tools, setTools] = useState<BrandingTools | null>(loaded);
  useEffect(() => {
    if (tools !== null) return;
    let live = true;
    void loadBrandingTools().then((ready) => {
      if (live) setTools(ready);
    });
    return () => {
      live = false;
    };
  }, [tools]);
  return tools;
}
