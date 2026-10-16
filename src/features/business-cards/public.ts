// BIZ-02: what the public card page receives from public.business_card_public(): only the shown fields.

export type PublicCard = {
  name: string;
  business: string;
  brand: { logoPath: string | null; color: string | null };
  builtWith: boolean;
  jobTitle: string | null;
  about: string | null;
  phone: string | null;
  // digits of the international number, for wa.me
  whatsapp: string | null;
  email: string | null;
  website: string | null;
  // the "leave details" form (a business that takes leads)
  form: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function publicCardFrom(data: unknown): PublicCard | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const name = str(d.name);
  const business = str(d.business);
  if (!name || !business) return null;
  const brand = d.brand && typeof d.brand === "object" ? (d.brand as Record<string, unknown>) : {};
  const whatsapp = str(d.whatsapp);
  const website = str(d.website);
  return {
    name,
    business,
    brand: { logoPath: str(brand.logo), color: str(brand.color) },
    builtWith: d.built_with === true,
    jobTitle: str(d.job_title),
    about: str(d.about),
    phone: str(d.phone),
    whatsapp: whatsapp && /^[1-9][0-9]{7,14}$/.test(whatsapp) ? whatsapp : null,
    email: str(d.email),
    website: website && /^https?:\/\//i.test(website) ? website : null,
    form: d.form === true,
  };
}
