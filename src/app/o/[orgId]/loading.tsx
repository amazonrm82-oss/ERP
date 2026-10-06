/** Content skeleton shown inside the app shell while a page loads its data. */
export default function Loading() {
  return (
    <div role="status" aria-label="טוען" className="animate-pulse">
      <div className="mb-6 h-8 w-40 rounded bg-line" />
      <div className="mb-4 h-11 w-full max-w-md rounded-md bg-line/70" />
      <div className="space-y-px overflow-hidden rounded-lg border border-line bg-surface">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-4 px-4 py-4">
            <div className="h-4 w-1/3 rounded bg-line" />
            <div className="h-4 w-1/5 rounded bg-line/70" />
            <div className="hidden h-4 w-1/6 rounded bg-line/70 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
