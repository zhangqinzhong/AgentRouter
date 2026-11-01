import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the custom tokens from styles/tokens.css so that, e.g.,
// `text-body` is merged as a font size rather than a text colour.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      container: ["page", "wide"],
      text: ["micro", "2xs", "label", "caption", "body", "body-sm", "title", "display"]
    },
    classGroups: {
      duration: [{ duration: ["fast", "base", "slow"] }]
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
