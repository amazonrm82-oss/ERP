/** Text with the "[to fill]" placeholders highlighted, so a missing detail cannot be overlooked. */
export function BlankText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[[^\]]+\])/).map((part, i) =>
        part.startsWith("[") ? (
          <mark key={i} className="rounded bg-warning-soft px-1 text-warning">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
