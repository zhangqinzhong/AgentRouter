import type {ComponentType, ReactNode} from 'react';
export const ToastProvider: ComponentType<{children?: ReactNode}>;
export function showToast(options: {title?: string; [key: string]: unknown}): unknown;
