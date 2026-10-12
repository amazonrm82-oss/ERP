import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { parseNote, type Inline } from "../markdown";

const linkClass = "text-accent underline underline-offset-4 hover:text-accent-strong";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === "text") {
      return <Fragment key={index}>{node.text}</Fragment>;
    }
    if (node.kind === "bold") {
      return <strong key={index} className="font-semibold">{renderInline(node.children)}</strong>;
    }
    // the address passed safeHref(): http(s), mailto: or tel: only
    return (
      <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {renderInline(node.children)}
        <span className="sr-only"> (נפתח בחלון חדש)</span>
      </a>
    );
  });
}

/**
 * A note with basic formatting (REC-04): bold, lists and links, built as React elements
 * from the stored Markdown. Never HTML from the text itself.
 */
export function NoteText({ text, className }: { text: string; className?: string }) {
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
                  {renderInline(line)}
                </Fragment>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="whitespace-pre-wrap">
            {renderInline(item)}
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
