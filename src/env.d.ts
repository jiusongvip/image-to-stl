/// <reference path="../.astro/types.d.ts" />

declare global {
  interface Window {
    dataLayer: any[];
  }
  function gtag(...args: any[]): void;
}

export {};