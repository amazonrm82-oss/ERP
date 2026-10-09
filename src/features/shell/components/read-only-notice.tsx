/** Shown instead of a create form to someone who can only view (viewer seat or a read-only organization). */
export function ReadOnlyNotice() {
  return (
    <p role="status" className="max-w-2xl rounded-lg border border-line bg-surface p-5 text-md">
      יש לכם הרשאת צפייה בלבד, ולכן אי אפשר להוסיף כאן רשומות. לשינוי ההרשאה יש לפנות למנהל המערכת בעסק.
    </p>
  );
}
