/** SEG-02: a list cell with a source and, under it, its campaign. */
export function SourceCell({ name, campaign }: { name: string | null; campaign: string | null }) {
  if (!name && !campaign) return null;
  return (
    <span className="block">
      {name ? <span className="block">{name}</span> : null}
      {campaign ? (
        <span className="block text-sm text-ink-soft">
          <bdi>{campaign}</bdi>
        </span>
      ) : null}
    </span>
  );
}
