import { describe, expect, it } from "vitest";

function installMatchMediaStub(): () => void {
  const previous = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: previous,
    });
  };
}

describe("controls teardown", () => {
  it.skipIf(typeof document === "undefined")("removes the injected OLED theme style on dispose", async () => {
    const restoreMatchMedia = installMatchMediaStub();
    try {
      const { createSensorControls } = await import("./controls");
      const initialCount = document.head.querySelectorAll("style[data-oled-theme]").length;
      const controls = createSensorControls(() => undefined, undefined, 60, false);

      expect(document.head.querySelectorAll("style[data-oled-theme]")).toHaveLength(initialCount + 1);
      controls.dispose();
      controls.dispose();
      expect(document.head.querySelectorAll("style[data-oled-theme]")).toHaveLength(initialCount);
    } finally {
      restoreMatchMedia();
    }
  });
});