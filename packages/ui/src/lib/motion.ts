// Motion values shared by components and pages. CSS transitions use the
// --duration-* and --ease-emphasized tokens in styles/tokens.css instead.
export const motionEase = [0.22, 1, 0.36, 1] as const;
export const reducedMotionTransition = { duration: 0.12, ease: "easeOut" } as const;
