/** Query parameters that only track where a click came from. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|ref_src)$/i,
];

export interface NormalizedUrl {
  /** The URL without its #fragment, cleaned up for comparison. */
  base: string;
  /** The #fragment, or "" when there is none. */
  hash: string;
}

/**
 * Cleans a URL up for duplicate detection:
 * lowercase host, no "www.", http and https treated alike, no trailing "/",
 * and no tracking parameters. The #fragment is returned separately because it
 * only sometimes matters (an anchor on a docs page vs. a view in a web app).
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { base: raw, hash: "" };
  }
  const hash = url.hash;
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }

  const isWeb = url.protocol === "http:" || url.protocol === "https:";
  const host = isWeb ? url.host.replace(/^www\./, "") : url.host;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const scheme = isWeb ? "" : url.protocol;
  return { base: `${scheme}//${host}${path}${url.search}`, hash };
}

/**
 * The site a URL belongs to, roughly its registrable domain
 * ("docs.google.com" -> "google.com", "bbc.co.uk" -> "bbc.co.uk").
 * Returns null for non-web URLs such as chrome://newtab.
 */
export function siteOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes(".")) return host;
  const parts = host.split(".");
  const tld = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // Country-code second-level domains such as co.uk, com.au, ne.jp.
  const take = parts.length > 2 && tld.length === 2 && second.length <= 3 ? 3 : 2;
  return parts.slice(-take).join(".");
}
