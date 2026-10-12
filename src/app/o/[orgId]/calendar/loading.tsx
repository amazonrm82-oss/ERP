import { ListPageSkeleton } from "@/components/ui/skeleton";

// DSN-12: a skeleton while the calendar's items load.
export default function Loading() {
  return <ListPageSkeleton />;
}
