import {getCopyLocale} from "../lib/copy";

export function useLocale() {
  return {resolvedLocale: getCopyLocale()};
}
