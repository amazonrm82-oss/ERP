import { cn } from "@/lib/cn";

/**
 * The business's own logo (FLD-04). Height and maximum width come from className
 * (no defaults, so they never fight); the width follows the image up to that limit,
 * so a wide logo does not push the header apart.
 * `alt` empty when the business name is written right next to it.
 */
export function OrgLogo({ url, alt, className }: { url: string; alt: string; className: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a customer's image from Storage, any size
    <img src={url} alt={alt} className={cn("w-auto shrink-0 object-contain", className)} />
  );
}
