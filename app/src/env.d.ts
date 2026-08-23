/// <reference types="vite/client" />

import type { DesktopBridge } from './lib/desktopBridge';

declare global {
  interface Window {
    diffuse: DesktopBridge;
  }
}
