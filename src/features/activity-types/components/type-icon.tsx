import type { SVGProps } from "react";

import {
  BellIcon,
  BoltIcon,
  BuildingIcon,
  CalendarIcon,
  ChartIcon,
  ChatIcon,
  CheckIcon,
  FormIcon,
  HomeIcon,
  MailIcon,
  PencilIcon,
  PhoneIcon,
  TagIcon,
  UsersIcon,
} from "@/components/ui/icons";

import type { ActivityTypeIcon } from "../types";

const ICONS: Record<ActivityTypeIcon, (props: SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  pencil: PencilIcon,
  phone: PhoneIcon,
  calendar: CalendarIcon,
  chat: ChatIcon,
  mail: MailIcon,
  users: UsersIcon,
  building: BuildingIcon,
  home: HomeIcon,
  check: CheckIcon,
  tag: TagIcon,
  bolt: BoltIcon,
  form: FormIcon,
  bell: BellIcon,
  chart: ChartIcon,
};

/** TASK-08: the icon of an activity type (decorative: its name is always shown next to it). */
export function TypeIcon({ icon, className = "size-4" }: { icon: ActivityTypeIcon; className?: string }) {
  const Glyph = ICONS[icon];
  return <Glyph className={className} />;
}
