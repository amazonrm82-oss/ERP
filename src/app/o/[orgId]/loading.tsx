import { DashboardSkeleton } from "@/components/ui/skeleton";

// DSN-12: "my day" while it loads. Every section below has its own loading.tsx in its own shape.
export default function Loading() {
  return <DashboardSkeleton />;
}
