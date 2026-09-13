export type MorphLayerMode = "stroke" | "fill";
export type MorphLayer = {
    id: string;
    name: string;
    from: string;
    loading?: string;
    to: string;
    fromOpacity: number;
    loadingOpacity?: number;
    toOpacity: number;
    mode: MorphLayerMode;
};
export type MorphLoadingDesign = {
    enabled: boolean;
    label: string;
    rotationCenter?: {
        x: number;
        y: number;
    };
    rotationDirection: "clockwise" | "counterclockwise";
    rotationDuration: number;
};
export type MorphAsset = {
    id: string;
    name: string;
    fromLabel: string;
    toLabel: string;
    fromIcon?: string;
    toIcon?: string;
    viewBox: string;
    strokeLocked?: boolean;
    loading?: MorphLoadingDesign;
    layers: MorphLayer[];
};
export type EditorSettings = {
    componentName: string;
    color: string;
    duration: number;
    loadingDuration: number;
    loadingEnabled: boolean;
    size: number;
    strokeWidth: number;
    showOnion: boolean;
};
