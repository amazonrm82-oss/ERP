import { IndustryLanding } from "@/features/landing/components/industry-page";
import { industryPage } from "@/features/landing/industries";
import { industryMetadata } from "@/features/landing/industry-metadata";

// VRT-02: the clinic kit's marketing page (public, static, from the kit in the code)
export const metadata = industryMetadata("clinic");

export default function IndustryPage() {
  return <IndustryLanding page={industryPage("clinic")} />;
}
