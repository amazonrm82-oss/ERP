// SPD-07: what the widget's script and form receive from public.site_widget_public(): display settings only.

export type WidgetPosition = "left" | "right";

export type PublicWidget = {
  label: string;
  position: WidgetPosition;
  business: string;
  brand: { logoPath: string | null; color: string | null };
  builtWith: boolean;
  // digits of the international number, for wa.me (null = no WhatsApp button)
  whatsapp: string | null;
  // "+<digits>", for tel: (null = no call button)
  call: string | null;
  // the short form (a business that takes leads, and the widget shows it)
  form: boolean;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function publicWidgetFrom(data: unknown): PublicWidget | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const label = str(d.label);
  const business = str(d.business);
  if (!label || !business) return null;
  const brand = d.brand && typeof d.brand === "object" && !Array.isArray(d.brand) ? (d.brand as Record<string, unknown>) : {};
  const whatsapp = str(d.whatsapp);
  const call = str(d.call);
  const color = str(brand.color);
  return {
    label: label.slice(0, 40),
    position: d.position === "right" ? "right" : "left",
    business,
    brand: { logoPath: str(brand.logo), color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : null },
    builtWith: d.built_with === true,
    whatsapp: whatsapp && /^[1-9][0-9]{7,14}$/.test(whatsapp) ? whatsapp : null,
    call: call && /^\+[1-9][0-9]{7,14}$/.test(call) ? call : null,
    form: d.form === true,
  };
}
