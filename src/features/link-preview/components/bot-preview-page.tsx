import { botPreviewLine, type BotPreviewState, type PreviewKind } from "../bot-preview";

/** WAB-05 follow-up: the whole page a listed preview bot gets. The preview lives in the metadata; this is one line. */
export function BotPreviewPage({ kind, state }: { kind: PreviewKind; state: BotPreviewState }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
      <p className="text-md text-ink">
        <bdi>{botPreviewLine(kind, state)}</bdi>
      </p>
    </main>
  );
}
