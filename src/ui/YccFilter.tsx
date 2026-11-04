// SVG filter applying the colour matrix correction to a plain <video> (engine/ycc.ts).

import { useId } from "react";
import { yccFilterValues } from "../engine/ycc";
import { playsOriginal } from "../lib/media";
import type { MediaAsset } from "../lib/types";

/** Returns the filter element to render and the CSS `filter` for the video (undefined = none). */
export function useYccFilter(asset: MediaAsset | null | undefined, useProxies: boolean): { svg: React.ReactNode; filter: string | undefined } {
  const id = `ycc${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const values = asset ? yccFilterValues(asset, playsOriginal(asset, useProxies)) : null;
  if (!values) return { svg: null, filter: undefined };
  return {
    svg: (
      <svg width="0" height="0" className="absolute" aria-hidden>
        <filter id={id} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={values} />
        </filter>
      </svg>
    ),
    filter: `url(#${id})`,
  };
}
