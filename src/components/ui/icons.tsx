import type { ReactNode, SVGProps } from "react";

// Small stroke icons, drawn on a 24px grid. Decorative by default: the text
// next to an icon carries the meaning, so icons are hidden from screen readers.
type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
    </Icon>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13.5 6.2 6a1.5 1.5 0 0 1 1.4-1h8.8a1.5 1.5 0 0 1 1.4 1L20 13.5" />
      <path d="M4 13.5h4.5l1 2h5l1-2H20V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8.5" r="3.25" />
      <path d="M3 19.5c.6-3 2.9-4.75 6-4.75s5.4 1.75 6 4.75" />
      <path d="M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17.5 15c1.9.6 3.1 2.1 3.5 4.5" />
    </Icon>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20M15 10h2.5A1.5 1.5 0 0 1 19 11.5V20M3.5 20h17" />
      <path d="M8.5 8h3M8.5 11.5h3M8.5 15h3" />
    </Icon>
  );
}

export function BoardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4.5" width="4.5" height="15" rx="1" />
      <rect x="10" y="4.5" width="4.5" height="10" rx="1" />
      <rect x="16" y="4.5" width="4.5" height="6.5" rx="1" />
    </Icon>
  );
}

export function CheckSquareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="m8.5 12.2 2.4 2.4 4.7-5" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 4h2.6l1.4 4-1.9 1.3a10.5 10.5 0 0 0 6.1 6.1l1.3-1.9 4 1.4v2.6A1.5 1.5 0 0 1 18.5 20 14.5 14.5 0 0 1 4 5.5 1.5 1.5 0 0 1 5.5 4z" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5a7.5 7.5 0 0 0-6.5 11.25L4.5 19.5l3.900-1A7.5 7.5 0 1 0 12 4.5z" />
    </Icon>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </Icon>
  );
}

/** Points left: "forward" in RTL. For "back", add rtl:rotate-180 (and ltr:rotate-180 for "forward"). */
export function ChevronIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14.5 6-6 6 6 6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.6a1.5 1.5 0 0 0 1.5 1.400h6.400a1.5 1.5 0 0 0 1.5-1.400L17.5 7" />
    </Icon>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10M14.5 8l4 4-4 4M18.5 12H9.5" />
    </Icon>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </Icon>
  );
}
