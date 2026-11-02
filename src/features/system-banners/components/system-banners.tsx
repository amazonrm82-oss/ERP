import { getSystemBanners } from "../queries";
import { BannerList } from "./banner-list";

/** ADM-04: the platform's messages at the top of every business screen (the slot in the business layout). */
export async function SystemBanners({ orgId }: { orgId: string }) {
  const banners = await getSystemBanners(orgId);
  if (banners.length === 0) return null;
  return <BannerList orgId={orgId} banners={banners} />;
}
