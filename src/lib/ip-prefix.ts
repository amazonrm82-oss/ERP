// OPS-02 review (medium): the shared per-sender limit of the secret-link pages (scope "public") counts a visitor by address. An
// IPv6 user usually holds a whole /64 and can rotate inside it at will, which would both dodge the limit and spray misses over
// other customers' buckets. So, for that scope only, an IPv6 address is reduced to its /64 prefix; an IPv4 address (and an
// IPv4-mapped IPv6 one) stays the whole IPv4 address. PRK-02's privacy page (scope "privacy") does the same. Every other scope
// keeps hashing the full address, unchanged. Pure.

function ipv4(text: string): string | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets.join(".") : null;
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, an embedded IPv4 tail split), or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  let rest = text;
  const lastColon = rest.lastIndexOf(":");
  if (rest.slice(lastColon + 1).includes(".")) {
    // an embedded IPv4 tail (::ffff:192.0.2.1) becomes its two groups
    const v4 = ipv4(rest.slice(lastColon + 1));
    if (!v4) return null;
    const [a, b, c, d] = v4.split(".").map(Number);
    rest = `${rest.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const back = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...back].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const known = head.length + back.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = halves.length === 2 ? Array<number>(8 - known).fill(0) : [];
  return [...head, ...zeros.map(String), ...back].map((g) => parseInt(g, 16));
}

/**
 * The address the shared limit counts: an IPv4 address as is; an IPv4-mapped IPv6 address (::ffff:a.b.c.d) as its IPv4; any
 * other IPv6 address as its /64 prefix ("2001:db8:0:1::/64", lower-case, `::` expanded); anything else unchanged (a value
 * that is not an address is hashed as it is, as before).
 */
export function publicSenderAddress(ip: string | null): string | null {
  if (!ip) return null;
  let text = ip.trim().toLowerCase();
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]"));
  text = text.replace(/%.*$/, "");
  if (!text.includes(":")) return ipv4(text) ?? ip;
  const groups = ipv6Groups(text);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}
