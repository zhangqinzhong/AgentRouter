export function useTheme(){return {resolvedTheme:typeof document!=='undefined' && document.documentElement.classList.contains('dark')?'dark':'light'};}
