import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { parseNote, type Inline } from "../markdown";

const linkClass = "text-accent underline underline-offset-4 hover:text-accent-strong";

// REC-02: user id -> current name; a mention of someone not listed shows the name it was written with
export type MentionNames = Readonly<Record<string, string>>;

function renderInline(nodes: Inline[], names: MentionNames): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === "text") {
      return <Fragment key={index}>{node.text}</Fragment>;
    }
    if (node.kind === "mention") {
      return (
        <span key={index} className="rounded-sm bg-accent-soft px-1 font-medium text-accent-strong">
          @{names[node.userId] ?? node.name}
        </span>
      );
    }
    if (node.kind === "bold") {
      return <strong key={index} className="font-semibold">{renderInline(node.children, names)}</strong>;
    }
    // the address passed safeHref(): http(s), mailto: or tel: only
    return (
      <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {renderInline(node.children, names)}
        <span className="sr-only"> (נפתח בחלון חדש)</span>
      </a>
    );
  });
}

/**
 * A note with basic formatting (REC-04): bold, lists and links, built as React elements
 * from the stored Markdown. Never HTML from the text itself. Mentions (REC-02) are highlighted.
 */
export function NoteText({ text, className, names = {} }: { text: string; className?: string; names?: MentionNames }) {
  const blocks = parseNote(text);
  return (
    <div className={cn("space-y-2 break-words", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "paragraph") {
          return (
            <p key={index} className="whitespace-pre-wrap">
              {block.lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 ? <br /> : null}
                  {renderInline(line, names)}
                </Fragment>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="whitespace-pre-wrap">
            {renderInline(item, names)}
          </li>
        ));
        return block.kind === "bullets" ? (
          <ul key={index} className="list-disc space-y-1 ps-5">
            {items}
          </ul>
        ) : (
          <ol key={index} start={block.start} className="list-decimal space-y-1 ps-6">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
