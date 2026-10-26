// FLD-06 part B: the outside links of an address field (owner, 18 October 2026): Waze and Google Maps, built from the
// address as typed, URL-encoded. No API key and no geocoding: the map service searches the text itself.

export type MapLinks = { waze: string; google: string };

/** Waze and Google Maps links for an address; null when the address is blank. */
export function mapLinks(address: string): MapLinks | null {
  const text = address.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const query = encodeURIComponent(text);
  return {
    waze: `https://waze.com/ul?q=${query}&navigate=yes`,
    google: `https://www.google.com/maps/search/?api=1&query=${query}`,
  };
}
