import type { HelpBlock } from "../types";

/** Renders an article. **Text** names a button, field or screen, and is shown bold. */
export function HelpBody({ blocks }: { blocks: HelpBlock[] }) {
  return (
    <div className="mt-6 space-y-4 text-lead leading-relaxed">
      {blocks.map((block, i) => {
        if ("h" in block) return <h2 key={i} className="pt-4 text-xl font-semibold">{block.h}</h2>;
        if ("p" in block) return <p key={i}>{rich(block.p)}</p>;
        if ("note" in block)
          return (
            <p key={i} className="rounded-lg border-s-4 border-accent bg-accent-soft px-4 py-3 text-md">
              {rich(block.note)}
            </p>
          );
        if ("steps" in block)
          return (
            <ol key={i} className="list-decimal space-y-2 ps-6 marker:font-semibold marker:text-accent-strong">
              {block.steps.map((s) => (
                <li key={s}>{rich(s)}</li>
              ))}
            </ol>
          );
        return (
          <ul key={i} className="list-disc space-y-1.5 ps-6">
            {block.list.map((s) => (
              <li key={s}>{rich(s)}</li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}

function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}
