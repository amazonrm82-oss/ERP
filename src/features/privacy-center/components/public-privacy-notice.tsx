import { publicFormNoticeParts, type PublicNoticeContact } from "../wordings";

/**
 * LEGAL-2 (4): the notice under every public form that collects a person's details (section 11 of the privacy law after
 * amendment 13). Plain text from the page's own answer (the business's name and contact); DRAFT wording of
 * PRIVACY_NOTICE_VERSION until the lawyer edits it.
 */
export function PublicPrivacyNotice({ contact, className }: { contact: PublicNoticeContact; className?: string }) {
  return (
    <p className={className ?? "mt-4 text-sm leading-relaxed text-ink-soft"} data-privacy-notice="">
      {publicFormNoticeParts(contact).map((part, index) =>
        part.ltr ? (
          <bdi key={index} dir="ltr">
            {part.text}
          </bdi>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}
