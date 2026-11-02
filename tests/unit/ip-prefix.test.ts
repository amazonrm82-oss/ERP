import { describe, expect, it } from "vitest";

import { publicSenderAddress } from "@/lib/ip-prefix";

// OPS-02 review (medium): the shared limit of the secret-link pages counts an IPv6 visitor by its /64, an IPv4 one by address.
describe("publicSenderAddress", () => {
  it("keeps an IPv4 address whole", () => {
    expect(publicSenderAddress("198.51.100.7")).toBe("198.51.100.7");
    expect(publicSenderAddress(" 198.51.100.7 ")).toBe("198.51.100.7");
  });

  it("reduces IPv6 to its /64, expanded and lower-case, so rotating inside the /64 is one sender", () => {
    const a = publicSenderAddress("2001:DB8:0:1:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:0:1::/64");
    expect(publicSenderAddress("2001:db8::1:0:0:0:1")).toBe("2001:db8:0:1::/64");
    expect(publicSenderAddress("2001:0db8:0000:0001::42")).toBe(a);
    expect(publicSenderAddress("[2001:db8:0:1::9]")).toBe(a);
    expect(publicSenderAddress("2001:db8:0:1::9%eth0")).toBe(a);
    expect(publicSenderAddress("2001:db8:0:2::9")).toBe("2001:db8:0:2::/64");
    expect(publicSenderAddress("::1")).toBe("0:0:0:0::/64");
    expect(publicSenderAddress("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(publicSenderAddress("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("an IPv4-mapped IPv6 address is its IPv4", () => {
    expect(publicSenderAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(publicSenderAddress("::FFFF:c633:6407")).toBe("198.51.100.7");
    expect(publicSenderAddress("0:0:0:0:0:ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  it("anything that is not an address is left as it is; null stays null", () => {
    expect(publicSenderAddress(null)).toBeNull();
    expect(publicSenderAddress("")).toBeNull();
    for (const odd of ["not-an-ip", "1::2::3", "2001:db8:0:1:2:3:4:5:6", "12345::1", "1.2.3", "300.1.1.1", "::ffff:1.2.3.999"]) {
      expect(publicSenderAddress(odd), odd).toBe(odd);
    }
  });
});
