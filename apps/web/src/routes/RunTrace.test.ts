import { describe, expect, it } from "vitest";
import { duration } from "./RunTrace.js";

describe("how long a run took", () => {
  it("uses milliseconds below a second, so a fast run is not '0.0s'", () => {
    expect(duration(32)).toBe("32ms");
    expect(duration(999)).toBe("999ms");
  });

  it("uses seconds, then minutes, as it gets longer", () => {
    expect(duration(1000)).toBe("1.0s");
    expect(duration(12_400)).toBe("12.4s");
    expect(duration(90_000)).toBe("1m 30s");
  });

  it("says nothing rather than zero when the run never ran", () => {
    expect(duration(null)).toBe("—");
  });
});
