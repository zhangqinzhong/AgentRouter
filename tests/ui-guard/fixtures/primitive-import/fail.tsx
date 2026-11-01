// Expected: 4 primitive-import violations.
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check } from "lucide-react";
import type { LucideIcon } from 'lucide-react';
export { Menu } from "@base-ui/react/menu";
export const icons: LucideIcon[] = [Check];
export const Switch = SwitchPrimitive.Root;
