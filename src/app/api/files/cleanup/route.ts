import { cleanupFiles } from "@/features/files/cleanup-server";

// Woken by the database at night when deleted rows left files in Storage. Secret in the Authorization header.
export async function POST(request: Request) {
  return cleanupFiles(request);
}
