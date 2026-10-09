"use client";

import { IconButton } from "@/components/ui/button";
import { ArrowDownIcon, ArrowUpIcon } from "@/components/ui/icons";

type Props = {
  // the name of the item, so "move up" says what moves
  name: string;
  onMove: (direction: -1 | 1) => void;
  first: boolean;
  last: boolean;
  disabled?: boolean;
};

/** Move an item up or down: the keyboard and screen-reader way to reorder (no drag needed). */
export function ReorderButtons({ name, onMove, first, last, disabled }: Props) {
  return (
    <span className="inline-flex">
      <IconButton label={`להזיז למעלה: ${name}`} icon={<ArrowUpIcon className="size-4.5" />} disabled={disabled || first} onClick={() => onMove(-1)} />
      <IconButton label={`להזיז למטה: ${name}`} icon={<ArrowDownIcon className="size-4.5" />} disabled={disabled || last} onClick={() => onMove(1)} />
    </span>
  );
}
