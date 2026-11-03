import { describe, expect, it } from "vitest";
import { normalizeUrl, siteOf } from "../src/core/url";

describe("normalizeUrl", () => {
  it("treats www, http/https, case and trailing slash alike", () => {
    expect(normalizeUrl("https://www.Example.com/a/").base).toBe(normalizeUrl("http://example.com/a").base);
  });
  it("strips tracking parameters but keeps real ones", () => {
    expect(normalizeUrl("https://x.com/p?id=3&utm_source=slack&fbclid=abc").base).toBe("//x.com/p?id=3");
    expect(normalizeUrl("https://x.com/p?utm_medium=email").base).toBe("//x.com/p");
  });
  it("returns the fragment separately", () => {
    expect(normalizeUrl("https://react.dev/ref#cleanup")).toEqual({ base: "//react.dev/ref", hash: "#cleanup" });
  });
  it("keeps the scheme for non-web URLs", () => {
    expect(normalizeUrl("chrome://newtab/").base).toBe("chrome://newtab/");
  });
  it("leaves unparseable URLs as they are", () => {
    expect(normalizeUrl("not a url").base).toBe("not a url");
  });
});

describe("siteOf", () => {
  it("returns the registrable domain", () => {
    expect(siteOf("https://docs.google.com/x")).toBe("google.com");
    expect(siteOf("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(siteOf("https://react.dev/learn")).toBe("react.dev");
    expect(siteOf("http://localhost:3000/")).toBe("localhost");
  });
  it("returns null for non-web pages", () => {
    expect(siteOf("chrome://extensions")).toBeNull();
  });
});
